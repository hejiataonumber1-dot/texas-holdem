const test=require('node:test');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const path=require('node:path');
const net=require('node:net');
const os=require('node:os');
const crypto=require('node:crypto');
const {WebSocket}=require('ws');

async function shuffleServer(t){
  const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
  const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const child=spawn(process.execPath,[path.resolve(__dirname,'../server/index.js')],{env:{...process.env,PORT:String(port),ALLOW_GUEST:'true',ROOM_CREATE_CODE:'',ADMIN_DATA_FILE:path.join(os.tmpdir(),'poker-shuffle-'+crypto.randomUUID()+'.json')},stdio:['ignore','pipe','pipe']});
  const peers=[];t.after(()=>{peers.forEach(peer=>peer.ws.terminate());child.kill();});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('启动超时')),5000);child.stdout.once('data',()=>{clearTimeout(timer);resolve();});child.once('error',reject);});
  return async function login(name,token){
    const ws=new WebSocket(`ws://127.0.0.1:${port}/ws`),messages=[],waiters=[],sequences=new WeakMap();let sequence=0;
    ws.on('message',data=>{const message=JSON.parse(data);sequences.set(message,++sequence);const index=waiters.findIndex(w=>sequence>w.after&&w.predicate(message));if(index<0)messages.push(message);else{const waiter=waiters.splice(index,1)[0];clearTimeout(waiter.timer);waiter.resolve(message);}});
    const peer={ws,send:message=>ws.send(JSON.stringify(message)),next(predicate,afterMessage){const after=afterMessage?sequences.get(afterMessage):0,index=messages.findIndex(message=>sequences.get(message)>after&&predicate(message));if(index>=0)return Promise.resolve(messages.splice(index,1)[0]);return new Promise((resolve,reject)=>{const waiter={predicate,after,resolve,timer:setTimeout(()=>{waiters.splice(waiters.indexOf(waiter),1);reject(Error('等待消息超时'));},3000)};waiters.push(waiter);});}};
    peers.push(peer);await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});peer.send({type:'hello',name,token});peer.auth=await peer.next(m=>m.type==='welcome');
    if(!token)await peer.next(m=>m.type==='lobby');return peer;
  };
}
const stateWhere=predicate=>m=>m.type==='state'&&predicate(m);
const pending=id=>stateWhere(m=>m.room.seatVote?.id===id);
const order=state=>state.game.players.map(p=>p.id);
const error=peer=>peer.next(m=>m.type==='error');

test('联网换位只在全员同意后发生，旁观者与伪造身份无权代投，下局按新座次行动',async t=>{
  const login=await shuffleServer(t),a=await login('换位甲'),b=await login('换位乙'),c=await login('换位丙'),watch=await login('换位观众');
  a.send({type:'create'});let state=await a.next(stateWhere(()=>true));const code=state.room.code,aid=state.you;
  watch.send({type:'join',code,spectator:true});const wid=(await watch.next(stateWhere(()=>true))).you;
  b.send({type:'join',code});const bid=(await b.next(stateWhere(()=>true))).you;
  c.send({type:'join',code});const cid=(await c.next(stateWhere(()=>true))).you;
  state=await a.next(stateWhere(m=>m.game.players.length===4));const before=order(state),summary=state.room.summary;
  b.send({type:'shuffle-request',playerId:aid});assert.match((await error(b)).message,/房主/);
  a.send({type:'shuffle-request'});state=await a.next(stateWhere(m=>!!m.room.seatVote));const vote=state.room.seatVote;
  assert.deepEqual(vote.participantIds,[aid,bid,cid]);assert.deepEqual(vote.approvedIds,[aid]);
  await b.next(pending(vote.id));await c.next(pending(vote.id));await watch.next(pending(vote.id));
  a.send({type:'start'});assert.match((await error(a)).message,/换位/);
  watch.send({type:'shuffle-vote',voteId:vote.id,agree:true,playerId:cid});assert.match((await error(watch)).message,/在座/);
  b.send({type:'shuffle-vote',voteId:'other-vote',agree:true});assert.match((await error(b)).message,/结束或更新/);
  b.send({type:'shuffle-vote',voteId:vote.id,agree:'true'});assert.match((await error(b)).message,/同意或拒绝/);
  b.send({type:'shuffle-vote',voteId:vote.id,agree:true});state=await a.next(stateWhere(m=>m.room.seatVote?.id===vote.id&&m.room.seatVote.approvedIds.length===2));
  assert.deepEqual(state.room.seatVote.approvedIds,[aid,bid]);assert.deepEqual(order(state),before);assert.deepEqual(state.room.summary,summary);
  const cPartial=await c.next(stateWhere(m=>m.room.seatVote?.id===vote.id&&m.room.seatVote.approvedIds.length===2));
  b.send({type:'shuffle-vote',voteId:vote.id,agree:true});const repeated=await a.next(stateWhere(m=>m.room.seatVote?.id===vote.id&&m.room.seatVote.approvedIds.length===2),state);
  assert.deepEqual(order(repeated),before);
  c.send({type:'shuffle-vote',voteId:vote.id,agree:true});state=await c.next(stateWhere(m=>m.room.seatVote===null),cPartial);
  const shuffled=order(state);assert.notDeepEqual(shuffled,before);assert.equal(shuffled[1],wid);assert.deepEqual(state.room.summary,summary);assert.equal(state.game.button,-1);assert.equal(state.game.hand,0);
  c.send({type:'shuffle-vote',voteId:vote.id,agree:true});assert.match((await error(c)).message,/结束或更新/);
  a.send({type:'start'});state=await a.next(stateWhere(m=>m.game.hand===1&&m.game.phase==='preflop'));
  assert.deepEqual(order(state),shuffled);assert.equal(state.room.seatVote,null);
  const seats=state.game.players.filter(p=>p.seated);assert.equal(state.game.players[state.game.button].id,seats[0].id);assert.equal(state.game.turnId,seats[0].id);assert.deepEqual(seats.map(p=>p.bet),[0,5,10]);
  a.send({type:'shuffle-request'});assert.match((await error(a)).message,/本局结束/);
});

test('联网换位拒绝、房主取消、离座、掉线和新玩家入座都会取消，旧同意不能复用',async t=>{
  const login=await shuffleServer(t),a=await login('取消甲');let b=await login('取消乙');const watch=await login('取消观众');
  a.send({type:'create'});let state=await a.next(stateWhere(()=>true));const code=state.room.code;
  b.send({type:'join',code});const bid=(await b.next(stateWhere(()=>true))).you;watch.send({type:'join',code,spectator:true});const wid=(await watch.next(stateWhere(()=>true))).you;
  state=await a.next(stateWhere(m=>m.game.players.length===3));const before=order(state);
  async function request(){a.send({type:'shuffle-request'});return a.next(stateWhere(m=>!!m.room.seatVote&&m.room.seatVote.id!==state.room.seatVote?.id),state);}
  state=await request();let vote=state.room.seatVote;
  b.send({type:'shuffle-vote',voteId:vote.id,agree:false});state=await a.next(stateWhere(m=>m.room.seatVote===null),state);assert.deepEqual(order(state),before);
  b.send({type:'shuffle-vote',voteId:vote.id,agree:true});assert.match((await error(b)).message,/结束或更新/);
  state=await request();vote=state.room.seatVote;
  b.send({type:'shuffle-cancel',voteId:vote.id});assert.match((await error(b)).message,/房主/);
  a.send({type:'shuffle-cancel',voteId:vote.id});state=await a.next(stateWhere(m=>m.room.seatVote===null),state);
  state=await request();b.send({type:'stand'});state=await a.next(stateWhere(m=>m.room.seatVote===null&&!m.game.players.find(p=>p.id===bid).seated),state);assert.deepEqual(order(state),before);
  a.send({type:'shuffle-request'});assert.match((await error(a)).message,/至少/);
  b.send({type:'seat'});state=await a.next(stateWhere(m=>m.game.players.find(p=>p.id===bid).seated),state);
  state=await request();const previousToken=b.auth.token;b.ws.close();state=await a.next(stateWhere(m=>m.room.seatVote===null&&!m.game.players.find(p=>p.id===bid).online),state);
  a.send({type:'shuffle-request'});assert.match((await error(a)).message,/在线/);
  b=await login('取消乙',previousToken);await b.next(stateWhere(m=>m.room.code===code));state=await a.next(stateWhere(m=>m.game.players.find(p=>p.id===bid).online),state);
  state=await request();watch.send({type:'seat'});state=await a.next(stateWhere(m=>m.room.seatVote===null&&m.game.players.find(p=>p.id===wid).seated),state);assert.deepEqual(order(state),before);
  a.send({type:'finish'});state=await a.next(stateWhere(m=>m.room.finished),state);a.send({type:'shuffle-request'});assert.match((await error(a)).message,/牌桌已结束/);
});
