const test=require('node:test');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const path=require('node:path');
const net=require('node:net');
const os=require('node:os');
const {randomUUID}=require('node:crypto');
const {WebSocket}=require('ws');

async function reactionServer(t){
  const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const child=spawn(process.execPath,[path.resolve(__dirname,'../server/index.js')],{env:{...process.env,PORT:String(port),ALLOW_GUEST:'true',ROOM_CREATE_CODE:'',ADMIN_DATA_FILE:path.join(os.tmpdir(),'poker-reactions-'+randomUUID()+'.json')},stdio:['ignore','pipe','pipe']});
  const peers=[];t.after(()=>{peers.forEach(peer=>peer.ws.terminate());child.kill();});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('启动超时')),5000);child.stdout.once('data',()=>{clearTimeout(timer);resolve();});child.once('error',reject);});
  return async function connect(name,token){
    const ws=new WebSocket(`ws://127.0.0.1:${port}/ws`),messages=[],all=[],waiters=[];let sequence=0;
    ws.on('message',data=>{const message=JSON.parse(data),entry={message,sequence:++sequence};all.push(entry);const index=waiters.findIndex(w=>sequence>w.after&&w.predicate(message));if(index<0)messages.push(entry);else{const waiter=waiters.splice(index,1)[0];clearTimeout(waiter.timer);waiter.resolve(message);}});
    const peer={ws,all,mark:()=>sequence,send:message=>ws.send(JSON.stringify(message)),next(predicate,after=0){const index=messages.findIndex(entry=>entry.sequence>after&&predicate(entry.message));if(index>=0)return Promise.resolve(messages.splice(index,1)[0].message);return new Promise((resolve,reject)=>{const waiter={predicate,after,resolve,timer:setTimeout(()=>{waiters.splice(waiters.indexOf(waiter),1);reject(Error('等待消息超时'));},3000)};waiters.push(waiter);});}};
    peers.push(peer);await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
    if(name){peer.send({type:'hello',name,token});peer.auth=await peer.next(m=>m.type==='welcome');if(!token)await peer.next(m=>m.type==='lobby');}
    return peer;
  };
}
const stateWhere=predicate=>m=>m.type==='state'&&predicate(m);
const reactionError=peer=>peer.next(m=>m.type==='reaction-error');

test('联网表情仅广播同房，真实身份覆盖伪造字段，观众可参与且不改变回合',async t=>{
  const connect=await reactionServer(t),a=await connect('表情甲'),b=await connect('表情乙'),watch=await connect('表情观众'),outside=await connect('其他房间'),anonymous=await connect();
  anonymous.send({type:'reaction',emoji:'like',to:'fake'});assert.match((await reactionError(anonymous)).message,/连接/);
  outside.send({type:'reaction',emoji:'like',to:'fake'});assert.match((await reactionError(outside)).message,/加入房间/);
  a.send({type:'create'});let state=await a.next(stateWhere(()=>true));const code=state.room.code,aid=state.you;
  b.send({type:'join',code});const bid=(await b.next(stateWhere(()=>true))).you;
  watch.send({type:'join',code,spectator:true});const wid=(await watch.next(stateWhere(()=>true))).you;
  outside.send({type:'create'});const otherState=await outside.next(stateWhere(()=>true));
  state=await a.next(stateWhere(m=>m.game.players.length===3));
  a.send({type:'reaction',emoji:'like',to:otherState.you});assert.match((await reactionError(a)).message,/离线|离开/);
  a.send({type:'reaction',emoji:'unsupported',to:bid});assert.match((await reactionError(a)).message,/支持/);
  a.send({type:'reaction',emoji:'laugh',to:bid,from:wid,fromName:'冒名',toName:'假的',room:otherState.room.code,id:'forged'});
  const event=await a.next(m=>m.type==='reaction');assert.equal(event.from,aid);assert.equal(event.to,bid);assert.equal(event.fromName,'表情甲');assert.equal(event.toName,'表情乙');assert.equal(event.room,code);assert.notEqual(event.id,'forged');
  assert.deepEqual(await b.next(m=>m.type==='reaction'),event);assert.deepEqual(await watch.next(m=>m.type==='reaction'),event);
  a.send({type:'start'});state=await a.next(stateWhere(m=>m.game.phase==='preflop'));
  watch.send({type:'reaction',emoji:'clap',to:aid});const spectatorEvent=await a.next(m=>m.type==='reaction'&&m.from===wid);assert.equal(spectatorEvent.fromName,'表情观众');
  const mark=a.mark();a.send({type:'join',code});const after=await a.next(stateWhere(m=>m.room.code===code),mark);
  assert.equal(after.room.deadline,state.room.deadline);assert.deepEqual(after.game,state.game);assert.deepEqual(after.room.summary,state.room.summary);
  const otherMark=outside.mark();outside.send({type:'join',code:otherState.room.code});await outside.next(stateWhere(()=>true),otherMark);
  for(let i=0;i<21;i++)anonymous.send({type:'reaction',emoji:'like',to:aid});
  const burstErrors=[];for(let i=0;i<21;i++)burstErrors.push(await reactionError(anonymous));
  assert.ok(burstErrors.some(error=>/太频繁/.test(error.message)));
  assert.equal(outside.all.some(x=>x.message.type==='reaction'),false);assert.equal(anonymous.all.some(x=>x.message.type==='error'),false);
  assert.equal(a.all.some(x=>x.message.type==='error'),false);
});

test('联网表情冷却跨重连保留，离线和已踢玩家不能收发，已结束牌桌可交流',async t=>{
  const connect=await reactionServer(t),a=await connect('冷却甲');let b=await connect('冷却乙');const watch=await connect('冷却观众');
  a.send({type:'create'});let state=await a.next(stateWhere(()=>true));const code=state.room.code,aid=state.you;
  b.send({type:'join',code});const bid=(await b.next(stateWhere(()=>true))).you;
  watch.send({type:'join',code,spectator:true});const wid=(await watch.next(stateWhere(()=>true))).you;
  await a.next(stateWhere(m=>m.game.players.length===3));
  b.send({type:'reaction',emoji:'cool',to:aid});await b.next(m=>m.type==='reaction'&&m.from===bid);
  b.send({type:'reaction',emoji:'cool',to:aid});let error=await reactionError(b);assert.ok(error.retryAfterMs>0&&error.retryAfterMs<=2000);
  const token=b.auth.token,oldB=b;const disconnected=a.mark();b.ws.close();await a.next(stateWhere(m=>!m.game.players.find(p=>p.id===bid).online),disconnected);
  watch.send({type:'reaction',emoji:'cry',to:bid});assert.match((await reactionError(watch)).message,/离线/);
  b=await connect('冷却乙',token);await b.next(stateWhere(m=>m.room.code===code));
  b.send({type:'reaction',emoji:'party',to:aid});error=await reactionError(b);assert.ok(error.retryAfterMs>0&&error.retryAfterMs<=2000);
  const marked=a.mark();a.send({type:'kick',playerId:bid});await b.next(m=>m.type==='lobby');state=await a.next(stateWhere(m=>!m.game.players.some(p=>p.id===bid)),marked);
  b.send({type:'reaction',emoji:'like',to:aid});assert.match((await reactionError(b)).message,/加入房间/);
  watch.send({type:'reaction',emoji:'like',to:bid});assert.match((await reactionError(watch)).message,/离线|离开/);
  a.send({type:'finish'});await a.next(stateWhere(m=>m.room.finished));
  watch.send({type:'reaction',emoji:'handshake',to:aid});const event=await watch.next(m=>m.type==='reaction'&&m.from===wid);assert.equal(event.to,aid);
  assert.equal(b.all.some(x=>x.message.type==='reaction'&&x.message.id===event.id),false);
  assert.equal(oldB.all.some(x=>x.message.type==='reaction-error'&&x.message.retryAfterMs>0),true);
  assert.equal(b.all.some(x=>x.message.type==='error'),false);
});
