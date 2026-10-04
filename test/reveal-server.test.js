const test=require('node:test');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const path=require('node:path');
const net=require('node:net');
const os=require('node:os');
const crypto=require('node:crypto');
const {WebSocket}=require('ws');

async function roomServer(t){
  const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
  const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const child=spawn(process.execPath,[path.resolve(__dirname,'../server/index.js')],{env:{...process.env,PORT:String(port),ALLOW_GUEST:'true',ROOM_CREATE_CODE:'',ADMIN_DATA_FILE:path.join(os.tmpdir(),'poker-reveal-'+crypto.randomUUID()+'.json')},stdio:['ignore','pipe','pipe']});
  const peers=[];t.after(()=>{peers.forEach(peer=>peer.ws.terminate());child.kill();});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('启动超时')),5000);child.stdout.once('data',()=>{clearTimeout(timer);resolve();});child.once('error',reject);});
  return async function login(name,token){
    const ws=new WebSocket(`ws://127.0.0.1:${port}/ws`),messages=[],waiters=[];
    ws.on('message',data=>{const message=JSON.parse(data),index=waiters.findIndex(w=>w.predicate(message));if(index<0)messages.push(message);else{const waiter=waiters.splice(index,1)[0];clearTimeout(waiter.timer);waiter.resolve(message);}});
    const peer={ws,send:message=>ws.send(JSON.stringify(message.type==='create'?{authorizationCode:'3333',...message}:message)),clear:()=>messages.splice(0),next(predicate){const index=messages.findIndex(predicate);if(index>=0)return Promise.resolve(messages.splice(index,1)[0]);return new Promise((resolve,reject)=>{const waiter={predicate,resolve,timer:setTimeout(()=>{waiters.splice(waiters.indexOf(waiter),1);reject(Error('等待消息超时'));},3000)};waiters.push(waiter);});}};
    peers.push(peer);await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
    peer.send({type:'hello',name,token});peer.auth=await peer.next(m=>m.type==='welcome');
    if(!token)await peer.next(m=>m.type==='lobby');return peer;
  };
}
const player=(state,id)=>state.game.players.find(p=>p.id===id);
const stateWhere=predicate=>m=>m.type==='state'&&predicate(m);
async function views(peers,predicate){return Promise.all(peers.map(peer=>peer.next(stateWhere(predicate))));}

test('双人摊牌向同房自动公开底牌和牌型，重复亮牌与重连不改变账目',async t=>{
  const login=await roomServer(t),a=await login('亮牌甲'),b=await login('亮牌乙'),watch=await login('围观者'),outside=await login('其他房主');
  a.send({type:'create'});let state=await a.next(stateWhere(()=>true));const code=state.room.code,aid=state.you;
  b.send({type:'join',code});const joined=await b.next(stateWhere(()=>true)),bid=joined.you;
  watch.send({type:'join',code,spectator:true});await watch.next(stateWhere(()=>true));
  outside.send({type:'create'});await outside.next(stateWhere(()=>true));
  const peers=[a,b,watch];peers.forEach(p=>p.clear());outside.clear();
  a.send({type:'start'});let snapshots=await views(peers,m=>m.game.phase==='preflop');state=snapshots[0];
  a.send({type:'reveal',hand:1});assert.match((await a.next(m=>m.type==='error')).message,/本局结束/);
  while(state.game.phase!=='ended'){
    for(const id of [aid,bid]){assert.equal(player(snapshots[2],id).revealed,false);assert.deepEqual(player(snapshots[2],id).cards,['??','??']);assert.equal(player(snapshots[2],id).handName,'');}
    const actor=state.game.turnId===aid?a:b,current=player(state,state.game.turnId),sequence=state.game.lastAction?.seq||0;
    actor.send({type:'action',action:current.bet<state.game.currentBet?'call':'check'});
    snapshots=await views(peers,m=>(m.game.lastAction?.seq||0)>sequence);state=snapshots[0];
  }
  const ownA=player(state,aid),ownB=player(snapshots[1],bid),settled=state.room.summary,results=state.game.handResults;
  assert.ok(ownA.handName);assert.ok(ownB.handName);
  for(const snapshot of snapshots)for(const own of [ownA,ownB]){
    assert.equal(player(snapshot,own.id).revealed,true);assert.deepEqual(player(snapshot,own.id).cards,own.cards);assert.equal(player(snapshot,own.id).handName,own.handName);
  }
  const eventCount=state.game.events.length;a.send({type:'reveal',hand:1});snapshots=await views(peers,m=>player(m,aid)?.revealed);
  assert.equal(snapshots[0].game.events.length,eventCount);
  assert.deepEqual(snapshots[0].room.summary,settled);assert.deepEqual(snapshots[0].game.handResults,results);
  outside.send({type:'reveal',hand:1,playerId:aid,code});assert.match((await outside.next(m=>m.type==='error')).message,/本局结束/);
  assert.equal(outside.clear().some(m=>m.type==='state'&&m.room.code===code),false);
  a.send({type:'finish'});await views(peers,m=>m.room.finished);
  b.send({type:'reveal',hand:1});snapshots=await views(peers,m=>player(m,bid)?.revealed);
  assert.deepEqual(player(snapshots[2],bid).cards,ownB.cards);assert.deepEqual(snapshots[2].room.summary,settled);
  const restored=await login('亮牌甲',a.auth.token);state=await restored.next(stateWhere(m=>m.room.finished));
  assert.deepEqual(player(state,aid).cards,ownA.cards);assert.deepEqual(player(state,bid).cards,ownB.cards);
  assert.ok(player(state,aid).revealed);assert.deepEqual(state.room.summary,settled);assert.deepEqual(state.game.handResults,results);
});

test('无需比牌时双方保密，玩家只能主动亮本人底牌，下一局重新隐藏',async t=>{
  const login=await roomServer(t),a=await login('弃牌甲'),b=await login('弃牌乙'),watch=await login('只观战');
  a.send({type:'create'});let state=await a.next(stateWhere(()=>true));const code=state.room.code,aid=state.you;
  b.send({type:'join',code});const bid=(await b.next(stateWhere(()=>true))).you;watch.send({type:'join',code,spectator:true});await watch.next(stateWhere(()=>true));
  const peers=[a,b,watch];peers.forEach(p=>p.clear());a.send({type:'start'});await views(peers,m=>m.game.hand===1);
  a.send({type:'action',action:'fold'});let snapshots=await views(peers,m=>m.game.phase==='ended');
  const cards=player(snapshots[0],aid).cards;assert.equal(player(snapshots[2],aid).folded,true);
  const settled=snapshots[0].room.summary,results=snapshots[0].game.handResults;
  for(const id of [aid,bid]){assert.equal(player(snapshots[2],id).revealed,false);assert.deepEqual(player(snapshots[2],id).cards,['??','??']);assert.equal(player(snapshots[2],id).handName,'');}
  watch.send({type:'reveal',hand:1,playerId:aid});assert.match((await watch.next(m=>m.type==='error')).message,/没有参与/);
  a.send({type:'reveal',hand:'1'});assert.match((await a.next(m=>m.type==='error')).message,/牌局已更新/);
  // A forged target id cannot expose the other player's still-private hand.
  a.send({type:'reveal',hand:1,playerId:bid,code:'000000'});snapshots=await views(peers,m=>player(m,aid)?.revealed);
  assert.deepEqual(player(snapshots[2],aid).cards,cards);
  assert.equal(player(snapshots[2],bid).revealed,false);assert.deepEqual(player(snapshots[2],bid).cards,['??','??']);
  assert.deepEqual(snapshots[2].room.summary,settled);assert.deepEqual(snapshots[2].game.handResults,results);
  a.send({type:'start'});snapshots=await views(peers,m=>m.game.hand===2);
  assert.equal(player(snapshots[2],aid).revealed,false);assert.deepEqual(player(snapshots[2],aid).cards,['??','??']);
  const actor=snapshots[0].game.turnId===aid?a:b;actor.send({type:'action',action:'fold'});await views(peers,m=>m.game.hand===2&&m.game.phase==='ended');
  a.send({type:'reveal',hand:1});assert.match((await a.next(m=>m.type==='error')).message,/牌局已更新/);
  a.send({type:'reveal',hand:2});snapshots=await views(peers,m=>m.game.hand===2&&player(m,aid)?.revealed);
  assert.equal(player(snapshots[2],aid).cards.includes('??'),false);
});
