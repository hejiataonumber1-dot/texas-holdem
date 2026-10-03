const test=require('node:test');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const {createInterface}=require('node:readline');
const path=require('node:path');
const net=require('node:net');
const os=require('node:os');
const crypto=require('node:crypto');
const {WebSocket}=require('ws');

async function loggingServer(t){
  const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
  const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const child=spawn(process.execPath,[path.resolve(__dirname,'../server/index.js')],{env:{...process.env,PORT:String(port),ALLOW_GUEST:'true',ROOM_CREATE_CODE:'',ADMIN_DATA_FILE:path.join(os.tmpdir(),'poker-hole-log-'+crypto.randomUUID()+'.json')},stdio:['ignore','pipe','pipe']});
  const peers=[],logs=[],lines=createInterface({input:child.stdout});
  lines.on('line',line=>{const match=/^\[(底牌|公共牌)\] (.*)$/.exec(line);if(match)logs.push({type:match[1],cards:JSON.parse(match[2])});});
  t.after(()=>{peers.forEach(peer=>peer.ws.terminate());child.kill();lines.close();});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('启动超时')),5000);child.stdout.once('data',()=>{clearTimeout(timer);resolve();});child.once('error',error=>{clearTimeout(timer);reject(error);});});
  async function login(name){
    const ws=new WebSocket(`ws://127.0.0.1:${port}/ws`),messages=[],waiters=[];
    ws.on('message',data=>{const message=JSON.parse(data),index=waiters.findIndex(waiter=>waiter.predicate(message));if(index<0)messages.push(message);else{const waiter=waiters.splice(index,1)[0];clearTimeout(waiter.timer);waiter.resolve(message);}});
    const peer={ws,send:message=>ws.send(JSON.stringify(message)),next(predicate){const index=messages.findIndex(predicate);if(index>=0)return Promise.resolve(messages.splice(index,1)[0]);return new Promise((resolve,reject)=>{const waiter={predicate,resolve,timer:setTimeout(()=>{const index=waiters.indexOf(waiter);if(index>=0)waiters.splice(index,1);reject(Error('等待消息超时'));},3000)};waiters.push(waiter);});}};
    peers.push(peer);await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
    peer.send({type:'hello',name});await peer.next(message=>message.type==='welcome');await peer.next(message=>message.type==='lobby');return peer;
  }
  return {login,logs,async stop(){const closed=once(child,'close');child.kill();await closed;}};
}
const stateWhere=predicate=>message=>message.type==='state'&&predicate(message);
const player=(state,id)=>state.game.players.find(item=>item.id===id);
const pretty=card=>({s:'黑桃',h:'红桃',d:'方块',c:'梅花'})[card[1]]+(card[0]==='T'?'10':card[0]);

test('No card logs during multiple hands; private cards remain isolated',async t=>{
  const server=await loggingServer(t),a=await server.login('日志甲'),b=await server.login('日志乙'),watch=await server.login('日志观众');
  a.send({type:'create'});const created=await a.next(stateWhere(()=>true)),code=created.room.code,aid=created.you;
  assert.equal(created.game.initialChips,2000);assert.equal(player(created,aid).chips,2000);
  a.send({type:'start'});assert.match((await a.next(message=>message.type==='error')).message,/至少需要/);
  b.send({type:'join',code});const bid=(await b.next(stateWhere(()=>true))).you;
  watch.send({type:'join',code,spectator:true});const wid=(await watch.next(stateWhere(()=>true))).you;
  const peers=[a,b,watch],expected=[];
  const views=predicate=>Promise.all(peers.map(peer=>peer.next(stateWhere(predicate))));
  function verifyPrivacy(snapshots){
    for(const state of snapshots){
      assert.deepEqual(player(state,wid).cards,[]);
      for(const id of [aid,bid]){
        assert.equal(player(state,id).cards.length,2);
        if(id!==state.you)assert.deepEqual(player(state,id).cards,['??','??']);
      }
      assert.equal(state.game.events.some(event=>/\[(底牌|公共牌)\]/.test(event)),false);
      for(const entry of expected.filter(entry=>entry.type==='底牌'))for(const dealt of entry.cards)for(const card of dealt.cards)assert.equal(state.game.events.some(event=>event.includes(card)),false);
    }
  }
  for(let hand=1;hand<=2;hand++){
    a.send({type:'start'});let snapshots=await views(state=>state.game.hand===hand&&state.game.phase==='preflop');
    expected.push({type:'底牌',cards:[{name:'日志甲',cards:player(snapshots[0],aid).cards.map(pretty)},{name:'日志乙',cards:player(snapshots[1],bid).cards.map(pretty)}]});
    for(const entry of expected.at(-1).cards)for(const card of entry.cards)assert.match(card,/^(黑桃|红桃|方块|梅花)([2-9]|10|J|Q|K|A)$/);
    verifyPrivacy(snapshots);
    if(hand===1){
      a.send({type:'start'});assert.match((await a.next(message=>message.type==='error')).message,/还没有结束/);
      b.send({type:'start'});assert.match((await b.next(message=>message.type==='error')).message,/只有房主/);
    }
    for(const [phase,boardSize] of [['preflop',0],['flop',3],['turn',4],['river',5]]){
      assert.equal(snapshots[0].game.phase,phase);assert.equal(snapshots[0].game.board.length,boardSize);
      if(boardSize)expected.push({type:'公共牌',cards:snapshots[0].game.board.map(pretty)});
      // Normal room broadcasts at every street must not duplicate either log.
      if(hand===1){
        a.send({type:'password',password:''});await a.next(message=>message.type==='room-settings-saved');
        verifyPrivacy(await views(state=>state.game.hand===hand&&state.game.phase===phase));
      }
      if(phase==='river'){
        (snapshots[0].game.turnId===aid?a:b).send({type:'action',action:'fold'});
        verifyPrivacy(await views(state=>state.game.hand===hand&&state.game.phase==='ended'));break;
      }
      while(snapshots[0].game.phase===phase){
        const game=snapshots[0].game,actor=game.turnId===aid?a:b,current=player(snapshots[0],game.turnId),sequence=game.lastAction?.seq||0;
        actor.send({type:'action',action:current.bet<game.currentBet?'call':'check'});
        snapshots=await views(state=>state.game.hand===hand&&(state.game.lastAction?.seq||0)>sequence);verifyPrivacy(snapshots);
      }
    }
  }
  // stdout and WebSocket data use separate streams. Closing the child drains
  // stdout before asserting the exact count, including absence of duplicates.
  await server.stop();assert.deepEqual(server.logs,[]);
});
