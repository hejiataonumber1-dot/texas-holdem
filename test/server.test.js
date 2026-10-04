const test=require('node:test');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const path=require('node:path');
const net=require('node:net');
const {WebSocket}=require('ws');
const os=require('node:os');
const crypto=require('node:crypto');
function testEnvironment(){return {...process.env,ADMIN_USERNAME:'test-admin',ADMIN_PASSWORD:'test-password-42',ROOM_CREATE_CODE:'test-create-code',ADMIN_DATA_FILE:path.join(os.tmpdir(),'poker-test-'+crypto.randomUUID()+'.json')};}

async function freePort(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
function client(url){
  const ws=new WebSocket(url),messages=[],waiters=[];
  ws.on('message',data=>{const m=JSON.parse(data);const i=waiters.findIndex(w=>w.predicate(m));if(i>=0){const w=waiters.splice(i,1)[0];clearTimeout(w.timer);w.resolve(m);}else messages.push(m);});
  const opened=new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
  return {ws,opened,send:m=>ws.send(JSON.stringify(m.type==='voice-join'?{relaySupported:true,...m}:m.type==='create'?{authorizationCode:'3333',smallBlind:10,bigBlind:20,...m}:m)),next(predicate){const i=messages.findIndex(predicate);if(i>=0)return Promise.resolve(messages.splice(i,1)[0]);return new Promise((resolve,reject)=>{const w={predicate,resolve,timer:setTimeout(()=>{const j=waiters.indexOf(w);if(j>=0)waiters.splice(j,1);reject(Error('等待服务端消息超时'));},3000)};waiters.push(w);});},clear(){messages.length=0;}};
}
test('实时语音信令仅在同一房间已加入的成员间转发，静音与断线清理',async t=>{
  const port=await freePort(),child=spawn(process.execPath,[path.resolve(__dirname,'../server/index.js')],{env:{...testEnvironment(),PORT:String(port),ALLOW_GUEST:'true',NODE_ENV:'production',VOICE_TEST_MODE:'true'},stdio:['ignore','pipe','pipe']});
  const clients=[];t.after(()=>{clients.forEach(c=>c.ws.terminate());child.kill();});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('启动超时')),5000);child.stdout.once('data',()=>{clearTimeout(timer);resolve();});child.once('error',reject);});
  assert.equal((await fetch(`http://127.0.0.1:${port}/voice-self-test`)).status,404);
  async function login(){const c=client(`ws://127.0.0.1:${port}/ws`);clients.push(c);await c.opened;c.send({type:'hello',name:'语音测试'+clients.length});await c.next(m=>m.type==='welcome');await c.next(m=>m.type==='lobby');return c;}
  const a=await login(),b=await login(),outside=await login();outside.send({type:'voice-join'});assert.match((await outside.next(m=>m.type==='error')).message,/加入房间/);
  a.send({type:'create',initialChips:500});let s=await a.next(m=>m.type==='state');const code=s.room.code;b.send({type:'join',code,spectator:true});await b.next(m=>m.type==='state');
  a.send({type:'voice-join'});const aj=await a.next(m=>m.type==='voice-joined');assert.equal(aj.peers[0].muted,true);const ap=aj.peers[0].peerId;
  b.send({type:'voice-join'});const bj=await b.next(m=>m.type==='voice-joined'),bp=bj.peers.find(p=>p.peerId!==ap).peerId;assert.equal(bj.peers.length,2);
  a.send({type:'voice-signal',to:bp,data:{kind:'description',description:{type:'offer',sdp:'x'.repeat(5000)}}});const signal=await b.next(m=>m.type==='voice-signal');assert.equal(signal.from,ap);assert.equal(signal.data.description.sdp.length,5000);
  outside.send({type:'create',initialChips:500});await outside.next(m=>m.type==='state');outside.send({type:'voice-join'});await outside.next(m=>m.type==='voice-joined');outside.send({type:'voice-signal',to:bp,data:{kind:'description',description:{type:'offer',sdp:'cross-room'}}});assert.match((await outside.next(m=>m.type==='voice-error')).message,/不存在/);
  a.send({type:'voice-mute',muted:false});await b.next(m=>m.type==='voice-roster'&&m.peers.some(p=>p.peerId===ap&&!p.muted));
  assert.equal(aj.transport,'relay');const audio=Buffer.alloc(1920,1).toString('base64');a.send({type:'voice-audio',data:audio});const audioReceived=await b.next(m=>m.type==='voice-audio');assert.equal(audioReceived.from,ap);assert.equal(audioReceived.data,audio);a.send({type:'voice-audio',data:'invalid'});assert.match((await a.next(m=>m.type==='voice-error')).message,/格式/);
  a.ws.terminate();const roster=await b.next(m=>m.type==='voice-roster'&&m.peers.length===1&&m.peers[0].peerId===bp);assert.equal(roster.peers[0].peerId,bp);
  b.send({type:'voice-leave'});await b.next(m=>m.type==='voice-left');b.send({type:'voice-signal',to:ap,data:{kind:'description',description:{type:'offer',sdp:'stale'}}});assert.match((await b.next(m=>m.type==='voice-error')).message,/不存在/);
});
test('语音连续发送和网络短突发不刷屏，超量受限后可恢复并继续操作',async t=>{
  const port=await freePort(),child=spawn(process.execPath,[path.resolve(__dirname,'../server/index.js')],{env:{...testEnvironment(),PORT:String(port),ALLOW_GUEST:'true',VOICE_TRANSPORT:'relay'},stdio:['ignore','pipe','pipe']});
  const clients=[];t.after(()=>{clients.forEach(c=>c.ws.terminate());child.kill();});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('启动超时')),5000);child.stdout.once('data',()=>{clearTimeout(timer);resolve();});child.once('error',reject);});
  async function login(name){const c=client(`ws://127.0.0.1:${port}/ws`);clients.push(c);await c.opened;c.send({type:'hello',name});await c.next(m=>m.type==='welcome');await c.next(m=>m.type==='lobby');return c;}
  const a=await login('语音发送者'),b=await login('语音接收者');
  a.send({type:'create',initialChips:500});const code=(await a.next(m=>m.type==='state')).room.code;b.send({type:'join',code});await b.next(m=>m.type==='state');
  a.send({type:'voice-join'});const aj=await a.next(m=>m.type==='voice-joined'),ap=aj.peers[0].peerId;
  b.send({type:'voice-join'});await b.next(m=>m.type==='voice-joined');
  const errors=[],received=[];
  for(const c of [a,b])c.ws.on('message',data=>{const m=JSON.parse(data);if(m.type==='error'||m.type==='voice-error')errors.push(m);});
  b.ws.on('message',data=>{const m=JSON.parse(data);if(m.type==='voice-audio')received.push(m);});
  // A roster sent after audio on the same connection is an ordered barrier for
  // both errors sent back to the speaker and audio forwarded to the listener.
  async function barrier(muted=false){a.clear();b.clear();a.send({type:'voice-mute',muted});await Promise.all([a,b].map(c=>c.next(m=>m.type==='voice-roster'&&m.peers.some(p=>p.peerId===ap&&p.muted===muted))));}
  const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms)),audio=Buffer.alloc(1920,1).toString('base64');
  const sendAudio=()=>a.send({type:'voice-audio',data:audio});
  await barrier();
  // Real capture produces a 60 ms packet. Stay below the normal rate while
  // crossing a full second, without depending on a particular window boundary.
  for(let i=0;i<24;i++){sendAudio();await delay(60);}
  await barrier();assert.equal(received.length,24);assert.deepEqual(errors,[]);
  received.length=0;
  // A short network stall can deliver many otherwise correctly paced frames at once.
  for(let i=0;i<36;i++)sendAudio();
  await barrier();assert.deepEqual(errors,[]);assert.equal(received.length,36);
  received.length=0;
  for(let i=0;i<200;i++)sendAudio();
  await barrier(true);assert.deepEqual(errors,[]);assert.ok(received.length<100,'超量音频应被丢弃，不能全部转发');
  // Audio throttling must not consume ordinary action/control quotas.
  a.clear();b.clear();a.send({type:'start'});const state=await a.next(m=>m.type==='state'&&m.game.phase==='preflop');await b.next(m=>m.type==='state'&&m.game.phase==='preflop');
  (state.game.turnId===state.you?a:b).send({type:'action',action:'fold'});await a.next(m=>m.type==='state'&&m.game.phase==='ended');await b.next(m=>m.type==='state'&&m.game.phase==='ended');
  await delay(150);
  received.length=0;sendAudio();await barrier(true);assert.equal(received.length,0,'闭麦时不得转发音频');
  await barrier(false);sendAudio();await barrier();assert.equal(received.length,1,'限流恢复后应自动继续转发音频');assert.deepEqual(errors,[]);
  a.send({type:'voice-leave'});await a.next(m=>m.type==='voice-left');await b.next(m=>m.type==='voice-roster'&&m.peers.length===1);assert.deepEqual(errors,[]);
});

test('创建房间固定校验后端认证码 3333，加入房间无需认证码',async t=>{
  const port=await freePort(),child=spawn(process.execPath,[path.resolve(__dirname,'../server/index.js')],{env:{...testEnvironment(),ROOM_CREATE_CODE:'other-environment-code',PORT:String(port),ALLOW_GUEST:'true',NODE_ENV:'production'},stdio:['ignore','pipe','pipe']});
  const clients=[];t.after(()=>{clients.forEach(c=>c.ws.terminate());child.kill();});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('启动超时')),5000);child.stdout.once('data',()=>{clearTimeout(timer);resolve();});child.once('error',reject);});
  const base=`http://127.0.0.1:${port}`;
  assert.deepEqual(await fetch(base+'/api/room-policy').then(r=>r.json()),{requireCode:true});
  async function loginPeer(name){const c=client(`ws://127.0.0.1:${port}/ws`);clients.push(c);await c.opened;c.send({type:'hello',name});await c.next(m=>m.type==='welcome');await c.next(m=>m.type==='lobby');return c;}
  const owner=await loginPeer('固定码房主'),friend=await loginPeer('固定码朋友');
  for(const authorizationCode of ['', '1111', 'other-environment-code']){owner.send({type:'create',initialChips:500,authorizationCode});assert.match((await owner.next(m=>m.type==='error')).message,/认证码/);}
  owner.send({type:'create',initialChips:500,authorizationCode:'3333',password:'room-password'});const state=await owner.next(m=>m.type==='state');
  assert.equal(JSON.stringify(state).includes('3333'),false);
  friend.send({type:'join',code:state.room.code,password:'room-password'});await friend.next(m=>m.type==='state');
});
test('观战不发底牌，离座与重新入座保留记录，牌局中预约离座',async t=>{
  const port=await freePort(),child=spawn(process.execPath,[path.resolve(__dirname,'../server/index.js')],{env:{...testEnvironment(),PORT:String(port),ALLOW_GUEST:'true'},stdio:['ignore','pipe','pipe']});
  const clients=[];t.after(()=>{clients.forEach(c=>c.ws.terminate());child.kill();});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('启动超时')),5000);child.stdout.once('data',()=>{clearTimeout(timer);resolve();});child.once('error',reject);});
  async function login(){const c=client(`ws://127.0.0.1:${port}/ws`);clients.push(c);await c.opened;c.send({type:'hello',name:'观战测试'+clients.length});await c.next(m=>m.type==='welcome');await c.next(m=>m.type==='lobby');return c;}
  const a=await login(),b=await login(),watch=await login();a.send({type:'create',initialChips:500});let s=await a.next(m=>m.type==='state');const code=s.room.code;
  b.send({type:'join',code});await b.next(m=>m.type==='state');await a.next(m=>m.type==='state'&&m.game.players.length===2);
  watch.send({type:'join',code,spectator:true});s=await watch.next(m=>m.type==='state');assert.equal(s.game.players.find(p=>p.id===s.you).seated,false);assert.equal(s.game.players.find(p=>p.id===s.you).chips,0);assert.equal(s.room.summary.length,2);
  watch.send({type:'rebuy'});assert.match((await watch.next(m=>m.type==='error')).message,/入座/);
  watch.send({type:'seat'});s=await watch.next(m=>m.type==='state'&&m.game.players.find(p=>p.id===m.you).seated);
  assert.equal(s.game.players.find(p=>p.id===s.you).chips,500);assert.equal(s.room.summary.find(p=>p.id===s.you).borrowed,0);
  watch.send({type:'stand'});await watch.next(m=>m.type==='state'&&!m.game.players.find(p=>p.id===m.you).seated);
  a.clear();b.clear();watch.clear();a.send({type:'start'});s=await a.next(m=>m.type==='state'&&m.game.phase==='preflop');await b.next(m=>m.type==='state'&&m.game.phase==='preflop');const ws=await watch.next(m=>m.type==='state'&&m.game.phase==='preflop');
  assert.deepEqual(ws.game.players.find(p=>p.id===ws.you).cards,[]);assert.ok(ws.game.players.filter(p=>p.seated).every(p=>p.cards.every(c=>c==='??')));
  // A spectator can leave while a hand is running without changing the actor.
  watch.send({type:'leave'});await watch.next(m=>m.type==='lobby');let next=await a.next(m=>m.type==='state'&&m.game.players.length===2);assert.equal(next.game.turnId,s.game.turnId);
  a.send({type:'stand'});next=await a.next(m=>m.type==='state'&&m.game.players.some(p=>p.pendingStand));assert.equal(next.game.players.find(p=>p.id===next.you).seated,true);
  a.send({type:'action',action:'fold'});next=await a.next(m=>m.type==='state'&&m.game.phase==='ended');const owner=next.game.players.find(p=>p.id===next.you);assert.equal(owner.seated,false);assert.equal(owner.pendingStand,false);assert.equal(owner.chips,490);
  const record=next.room.summary.find(p=>p.id===owner.id);a.send({type:'seat'});next=await a.next(m=>m.type==='state'&&m.game.players.find(p=>p.id===m.you).seated);assert.equal(next.game.players.find(p=>p.id===next.you).chips,490);assert.deepEqual(next.room.summary.find(p=>p.id===owner.id),record);
  a.clear();b.clear();a.send({type:'start'});next=await a.next(m=>m.type==='state'&&m.game.hand===2);assert.equal(next.game.players.find(p=>p.id===next.you).inHand,true);
});
test('借筹码记账、离开恢复、房主结束固定总计并禁止继续游戏',async t=>{
  const port=await freePort(),child=spawn(process.execPath,[path.resolve(__dirname,'../server/index.js')],{env:{...testEnvironment(),PORT:String(port),ALLOW_GUEST:'true'},stdio:['ignore','pipe','pipe']});
  const clients=[];t.after(()=>{clients.forEach(c=>c.ws.terminate());child.kill();});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('启动超时')),5000);child.stdout.once('data',()=>{clearTimeout(timer);resolve();});child.once('error',reject);});
  async function login(token){const c=client(`ws://127.0.0.1:${port}/ws`);clients.push(c);await c.opened;c.send({type:'hello',name:'总计测试'+clients.length,token});c.auth=await c.next(m=>m.type==='welcome');return c;}
  const a=await login(),b=await login();await a.next(m=>m.type==='lobby');await b.next(m=>m.type==='lobby');a.send({type:'create',initialChips:500});let state=await a.next(m=>m.type==='state');const code=state.room.code;
  b.send({type:'join',code});await b.next(m=>m.type==='state');await a.next(m=>m.type==='state'&&m.game.players.length===2);
  b.send({type:'finish'});assert.match((await b.next(m=>m.type==='error')).message,/只有房主/);
  a.send({type:'rebuy'});assert.match((await a.next(m=>m.type==='error')).message,/输光/);
  // Play real hands to produce a bust, retrying the rare split pot.
  for(let i=0;i<12;i++){
    a.clear();b.clear();a.send({type:'start'});state=await a.next(m=>m.type==='state'&&m.game.phase==='preflop');await b.next(m=>m.type==='state'&&m.game.phase==='preflop');
    a.send({type:'finish'});assert.match((await a.next(m=>m.type==='error')).message,/本局结束/);
    a.send({type:'rebuy'});assert.match((await a.next(m=>m.type==='error')).message,/本局结束/);
    const actor=state.game.turnId===state.you?a:b;
    const actorId=state.game.turnId,stack=state.game.players.find(p=>p.id===actorId);
    actor.send({type:'action',action:'raise',amount:stack.chips+stack.bet});await a.next(m=>m.type==='state'&&m.game.currentBet===500);await b.next(m=>m.type==='state'&&m.game.currentBet===500);
    (actor===a?b:a).send({type:'action',action:'call'});state=await a.next(m=>m.type==='state'&&m.game.phase==='ended');await b.next(m=>m.type==='state'&&m.game.phase==='ended');
    if(state.game.players.some(p=>p.chips===0))break;
  }
  const bust=state.game.players.find(p=>p.chips===0);assert.ok(bust);const borrower=bust.id===state.you?a:b;
  borrower.send({type:'rebuy',amount:999999});state=await a.next(m=>m.type==='state'&&m.room.summary.some(p=>p.borrowed===500));await b.next(m=>m.type==='state'&&m.room.summary.some(p=>p.borrowed===500));
  assert.equal(state.room.summary.find(p=>p.id===bust.id).net,0);assert.equal(state.room.summary.reduce((sum,p)=>sum+p.net,0),1000);
  b.send({type:'leave'});await b.next(m=>m.type==='lobby');await a.next(m=>m.type==='state'&&m.game.players.length===1);
  b.send({type:'join',code});state=await b.next(m=>m.type==='state');assert.equal(state.room.summary.length,2);assert.equal(state.game.players.find(p=>p.id===state.you).chips,bust.id===state.you?500:1000);
  await a.next(m=>m.type==='state'&&m.game.players.length===2);b.send({type:'leave'});await b.next(m=>m.type==='lobby');await a.next(m=>m.type==='state'&&m.game.players.length===1);
  a.send({type:'finish'});state=await a.next(m=>m.type==='state'&&m.room.finished);assert.equal(state.room.summary.length,2);assert.equal(state.room.summary.reduce((sum,p)=>sum+p.borrowed,0),500);const frozen=state.room.summary;
  for(const type of ['start','rebuy','action']){a.send({type});assert.match((await a.next(m=>m.type==='error')).message,/牌桌已结束/);}
  b.send({type:'join',code});assert.match((await b.next(m=>m.type==='error')).message,/牌桌已结束/);
  a.ws.terminate();const restored=await login(a.auth.token);state=await restored.next(m=>m.type==='state'&&m.room.finished);assert.deepEqual(state.room.summary,frozen);
});
test('多人连接、房主权限、底牌隔离、重连和游客加入',async t=>{
  const port=await freePort();const child=spawn(process.execPath,[path.resolve(__dirname,'../server/index.js')],{env:{...testEnvironment(),PORT:String(port)},stdio:['ignore','pipe','pipe']});
  const clients=[];t.after(()=>{clients.forEach(c=>c.ws.terminate());child.kill();});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('启动超时')),5000);child.stdout.once('data',()=>{clearTimeout(timer);resolve();});child.once('error',reject);});
  async function login(name,token){const c=client(`ws://127.0.0.1:${port}/ws`);clients.push(c);await c.opened;c.send({type:'hello',name,token});c.auth=await c.next(m=>m.type==='welcome');return c;}
  const a=await login('房主'),b=await login('朋友');await a.next(m=>m.type==='lobby');await b.next(m=>m.type==='lobby');
  a.send({type:'create',initialChips:500});let state=await a.next(m=>m.type==='state');const code=state.room.code;
  assert.notEqual(state.you,a.auth.token);
  b.send({type:'join',code});await b.next(m=>m.type==='state');await a.next(m=>m.type==='state'&&m.game.players.length===2);
  b.send({type:'start'});assert.match((await b.next(m=>m.type==='error')).message,/只有房主/);
  a.send({type:'start'});state=await a.next(m=>m.type==='state'&&m.game.phase==='preflop');const bs=await b.next(m=>m.type==='state'&&m.game.phase==='preflop');
  const originalCards=state.game.players.find(p=>p.id===state.you).cards;
  assert.equal(originalCards.length,2);
  assert.deepEqual(bs.game.players.find(p=>p.id===state.you).cards,['??','??']);
  assert.equal(JSON.stringify(bs).includes(a.auth.token),false);
  const c=await login('迟到的朋友');await c.next(m=>m.type==='lobby');c.send({type:'join',code});const cs=await c.next(m=>m.type==='state');assert.equal(cs.game.players.find(p=>p.id===cs.you).inHand,false);
  const deadline=cs.room.deadline;a.ws.terminate();
  const rejoined=await login('房主',a.auth.token);state=await rejoined.next(m=>m.type==='state');assert.equal(state.game.phase,'preflop');assert.equal(state.room.deadline,deadline);
  assert.deepEqual(state.game.players.find(p=>p.id===state.you).cards,originalCards);
  rejoined.send({type:'action',action:'raise',amount:500});await rejoined.next(m=>m.type==='state'&&m.game.currentBet===500);
  b.send({type:'action',action:'call'});state=await rejoined.next(m=>m.type==='state'&&m.game.phase==='ended');
  assert.equal(state.game.board.length,5);assert.equal(state.game.players.reduce((n,p)=>n+p.chips,0),1500);
  c.send({type:'leave'});await c.next(m=>m.type==='lobby');
});
test('微信 HTTP 登录签发令牌、恢复原座位且禁止游客绕过',async t=>{
  const port=await freePort();
  const child=spawn(process.execPath,['--require',path.resolve(__dirname,'fake-wechat.cjs'),path.resolve(__dirname,'../server/index.js')],{env:{...testEnvironment(),PORT:String(port),WECHAT_APP_ID:'test-app',WECHAT_APP_SECRET:'test-secret',ALLOW_GUEST:'false'},stdio:['ignore','pipe','pipe']});
  const clients=[];t.after(()=>{clients.forEach(c=>c.ws.terminate());child.kill();});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('启动超时')),5000);child.stdout.once('data',()=>{clearTimeout(timer);resolve();});child.once('error',reject);});
  async function auth(code,extra={}){const response=await fetch(`http://127.0.0.1:${port}/api/auth/wechat`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code,name:'微信玩家',...extra})});return {status:response.status,data:await response.json()};}
  const first=await auth('code-a',{openid:'attacker-chosen-id'});assert.equal(first.status,200);assert.equal(JSON.stringify(first.data).includes('private-wechat-key'),false);assert.equal(JSON.stringify(first.data).includes('verified-a'),false);
  const guest=client(`ws://127.0.0.1:${port}/ws`);clients.push(guest);await guest.opened;guest.send({type:'hello',name:'游客'});assert.equal((await guest.next(m=>m.type==='error')).code,'AUTH_EXPIRED');
  const a=client(`ws://127.0.0.1:${port}/ws`);clients.push(a);await a.opened;a.send({type:'hello',token:first.data.token,platform:'wechat'});assert.equal((await a.next(m=>m.type==='welcome')).loginType,'wechat');await a.next(m=>m.type==='lobby');
  a.send({type:'create',initialChips:500});const original=await a.next(m=>m.type==='state');
  const second=await auth('code-a-again');assert.equal(second.data.user.id,first.data.user.id);assert.notEqual(second.data.token,first.data.token);
  const fresh=client(`ws://127.0.0.1:${port}/ws`);clients.push(fresh);await fresh.opened;fresh.send({type:'hello',token:second.data.token,platform:'wechat'});await fresh.next(m=>m.type==='welcome');const recovered=await fresh.next(m=>m.type==='state');assert.equal(recovered.room.code,original.room.code);assert.equal(recovered.you,original.you);await a.next(m=>m.type==='replaced');
  guest.send({type:'hello',token:first.data.token,platform:'wechat'});assert.equal((await guest.next(m=>m.type==='error')).code,'AUTH_EXPIRED');
  const other=await auth('code-b');assert.notEqual(other.data.user.id,first.data.user.id);
  const otherClient=client(`ws://127.0.0.1:${port}/ws`);clients.push(otherClient);await otherClient.opened;otherClient.send({type:'hello',token:other.data.token,platform:'wechat'});await otherClient.next(m=>m.type==='welcome');await otherClient.next(m=>m.type==='lobby');otherClient.send({type:'join',code:original.room.code});assert.match((await otherClient.next(m=>m.type==='error')).message,/原账号/);
  assert.equal((await auth('invalid-code')).status,401);
});

async function membershipServer(t){
  const port=await freePort(),child=spawn(process.execPath,[path.resolve(__dirname,'../server/index.js')],{env:{...testEnvironment(),PORT:String(port),ALLOW_GUEST:'true'},stdio:['ignore','pipe','pipe']});
  const peers=[];t.after(()=>{peers.forEach(c=>c.ws.terminate());child.kill();});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('启动超时')),5000);child.stdout.once('data',()=>{clearTimeout(timer);resolve();});child.once('error',reject);});
  return async function login(name,token){const c=client(`ws://127.0.0.1:${port}/ws`);peers.push(c);await c.opened;c.send({type:'hello',name,token});c.auth=await c.next(m=>m.type==='welcome');await c.next(m=>m.type==='lobby');return c;};
}

for(const count of [3,4])test(`${count}人新房只扣默认5/10大小盲，非盲位弃牌不扣筹码，换轮可过牌且调盲不添加底注`,async t=>{
  const login=await membershipServer(t),peers=[];
  for(let i=0;i<count;i++)peers.push(await login(`无底注玩家${i}`));
  const host=peers[0];
  // Omit both values to exercise the server defaults, not the test helper's 10/20.
  host.send({type:'create',initialChips:500,smallBlind:undefined,bigBlind:undefined});
  let state=await host.next(m=>m.type==='state');const code=state.room.code;host.id=state.you;
  assert.equal(state.game.smallBlind,5);assert.equal(state.game.bigBlind,10);assert.equal(state.game.ante,0);
  for(const peer of peers.slice(1)){peer.send({type:'join',code});peer.id=(await peer.next(m=>m.type==='state')).you;}
  await host.next(m=>m.type==='state'&&m.game.players.length===count);host.clear();
  host.send({type:'start'});state=await host.next(m=>m.type==='state'&&m.game.phase==='preflop');
  assert.equal(state.game.pot,15);
  assert.deepEqual(state.game.players.map(p=>p.bet),count===3?[0,5,10]:[0,5,10,0]);
  for(const p of state.game.players){assert.equal(p.chips,500-p.bet);assert.equal(p.total,p.bet);}
  const nonBlindIds=state.game.players.filter(p=>p.bet===0).map(p=>p.id);
  async function act(action){
    const actor=peers.find(p=>p.id===state.game.turnId);assert.ok(actor);host.clear();
    actor.send({type:'action',action});state=await host.next(m=>m.type==='state');
  }
  for(let i=0;i<count-2;i++){
    const id=state.game.turnId;assert.ok(nonBlindIds.includes(id));await act('fold');
    const folded=state.game.players.find(p=>p.id===id);assert.equal(folded.chips,500);assert.equal(folded.total,0);assert.equal(folded.folded,true);assert.equal(state.game.pot,15);
  }
  assert.equal(state.game.turnId,peers[1].id);await act('call');
  assert.equal(state.game.turnId,peers[2].id);await act('check');
  for(const phase of ['flop','turn','river']){
    assert.equal(state.game.phase,phase);assert.equal(state.game.currentBet,0);assert.equal(state.game.pot,20);
    assert.ok(state.game.players.every(p=>p.bet===0));
    assert.deepEqual(state.game.players.map(p=>p.chips),count===3?[500,490,490]:[500,490,490,500]);
    await act('check');await act('check');
  }
  assert.equal(state.game.phase,'ended');assert.equal(state.room.summary.reduce((sum,p)=>sum+p.net,0),count*500);
  for(const id of nonBlindIds)assert.equal(state.game.handResults.players.find(p=>p.id===id).net,0);
  host.clear();host.send({type:'blinds',smallBlind:10,bigBlind:20});state=await host.next(m=>m.type==='state'&&m.game.bigBlind===20);
  assert.equal(state.game.ante,0);const balances=new Map(state.game.players.map(p=>[p.id,p.chips]));
  host.send({type:'start'});state=await host.next(m=>m.type==='state'&&m.game.hand===2);
  assert.equal(state.game.pot,30);assert.equal(state.game.ante,0);
  assert.deepEqual(state.game.players.map(p=>p.bet),count===3?[20,0,10]:[0,0,10,20]);
  for(const p of state.game.players){assert.equal(p.total,p.bet);assert.equal(p.chips,balances.get(p.id)-p.bet);}
});

test('成功行动为全房玩家和观众同步独立音效，跨轮和结算不遗漏、非法请求不触发',async t=>{
  const {PokerSounds}=require('../web/table-controls');
  const login=await membershipServer(t),a=await login('音效房主'),b=await login('音效朋友'),watch=await login('音效观众'),peers=[a,b,watch];
  a.send({type:'create',initialChips:500});const code=(await a.next(m=>m.type==='state')).room.code;
  b.send({type:'join',code});await b.next(m=>m.type==='state');watch.send({type:'join',code,spectator:true});await watch.next(m=>m.type==='state');
  const heard=peers.map(()=>[]),sounds=heard.map(list=>new PokerSounds({play:kind=>list.push(kind)}));
  for(const peer of peers)peer.clear();
  a.send({type:'join',code});
  async function states(predicate){const result=await Promise.all(peers.map(p=>p.next(m=>m.type==='state'&&predicate(m))));result.forEach((s,i)=>sounds[i].update(s));return result[0];}
  const waiting=await states(m=>m.game.players.length===3);assert.equal(waiting.game.lastAction,null);
  a.send({type:'start'});const initial=await states(m=>m.game.phase==='preflop');
  b.send({type:'action',action:'check'});assert.match((await b.next(m=>m.type==='error')).message,/还没轮到/);
  a.send({type:'join',code});assert.equal((await states(()=>true)).game.lastAction,null);
  let seq=0;
  async function action(peer,type,kind,amount){
    peer.send({type:'action',action:type,amount});seq++;
    const result=await states(m=>m.game.lastAction?.seq===seq);
    assert.equal(result.game.lastAction.kind,kind);assert.equal(result.game.lastAction.hand,result.game.hand);
    assert.equal(result.game.lastAction.playerId,peer===a?initial.you:result.game.players.find(p=>p.name==='音效朋友').id);
    return result;
  }
  await action(a,'call','call');const flop=await action(b,'check','check');assert.equal(flop.game.phase,'flop');
  await action(b,'raise','bet',20);await action(a,'raise','raise',40);await action(b,'call','call');
  await action(b,'check','check');assert.equal((await action(a,'fold','fold')).game.phase,'ended');
  a.send({type:'start'});const next=await states(m=>m.game.hand===2);const actor=next.game.turnId===initial.you?a:b,p=next.game.players.find(p=>p.id===next.game.turnId);
  await action(actor,'raise','allin',p.bet+p.chips);
  const ended=await action(actor===a?b:a,'call','allin');assert.equal(ended.game.phase,'ended');assert.equal(ended.game.board.length,5);
  const expected=['deal','call','check','deal','bet','raise','call','deal','check','fold','deal','allin','allin','deal'];
  heard.forEach(list=>assert.deepEqual(list,expected));
});

test('同名重入无重复：在线拒绝、密码先验证、掉线恢复底牌和筹码且不重置计时',async t=>{
  const login=await membershipServer(t),a=await login('房主'),b=await login('Alice'),fresh=await login(' ALICE ');
  a.send({type:'create',initialChips:500,password:'table-password'});const code=(await a.next(m=>m.type==='state')).room.code;
  b.send({type:'join',code,password:'table-password'});let original=await b.next(m=>m.type==='state');await a.next(m=>m.type==='state'&&m.game.players.length===2);
  b.send({type:'join',code,password:'table-password'});assert.equal((await b.next(m=>m.type==='state')).game.players.length,2);
  fresh.send({type:'join',code,password:'wrong-password'});assert.match((await fresh.next(m=>m.type==='error')).message,/密码不正确/);
  fresh.send({type:'join',code,password:'table-password'});assert.match((await fresh.next(m=>m.type==='error')).message,/仍在线/);
  a.clear();b.clear();a.send({type:'start'});await a.next(m=>m.type==='state'&&m.game.phase==='preflop');original=await b.next(m=>m.type==='state'&&m.game.phase==='preflop');const before=original.game.players.find(p=>p.id===original.you);
  b.ws.terminate();await a.next(m=>m.type==='state'&&m.game.players.some(p=>p.id===original.you&&!p.online));
  fresh.send({type:'join',code,password:'table-password',spectator:true});const auth=await fresh.next(m=>m.type==='welcome'&&m.recovered);const recovered=await fresh.next(m=>m.type==='state');
  assert.equal(recovered.you,original.you);assert.equal(auth.name,'Alice');assert.notEqual(auth.token,b.auth.token);assert.equal(recovered.game.players.length,2);assert.deepEqual(recovered.game.players.find(p=>p.id===recovered.you),{...before,online:true});assert.equal(recovered.room.deadline,original.room.deadline);assert.equal(recovered.room.summary.length,2);
  fresh.clear();fresh.send({type:'join',code,name:'Alice'});assert.equal((await fresh.next(m=>m.type==='state')).game.players.length,2);
});

test('只有房主可踢同房成员，踢人清理语音、通知回大厅，保留总结且本局仍结算',async t=>{
  const login=await membershipServer(t),a=await login('房主'),b=await login('朋友甲'),c=await login('朋友乙'),outside=await login('外桌玩家');
  a.send({type:'create',initialChips:500});const code=(await a.next(m=>m.type==='state')).room.code;
  for(const p of [b,c]){p.send({type:'join',code});await p.next(m=>m.type==='state');}
  let state=await a.next(m=>m.type==='state'&&m.game.players.length===3);const bid=state.game.players.find(p=>p.name==='朋友甲').id,cid=state.game.players.find(p=>p.name==='朋友乙').id;
  outside.send({type:'create',initialChips:500});const otherId=(await outside.next(m=>m.type==='state')).you;
  b.send({type:'kick',playerId:cid});assert.match((await b.next(m=>m.type==='error')).message,/只有房主/);
  a.send({type:'kick',playerId:state.you});assert.match((await a.next(m=>m.type==='error')).message,/自己/);
  a.send({type:'kick',playerId:otherId});assert.match((await a.next(m=>m.type==='error')).message,/已离开/);
  b.send({type:'voice-join'});await b.next(m=>m.type==='voice-joined');
  a.clear();b.clear();c.clear();a.send({type:'start'});state=await a.next(m=>m.type==='state'&&m.game.phase==='preflop');const deadline=state.room.deadline,pot=state.game.pot;
  c.ws.terminate();await a.next(m=>m.type==='state'&&m.game.players.some(p=>p.id===cid&&!p.online));
  a.send({type:'kick',playerId:cid});state=await a.next(m=>m.type==='state'&&m.game.players.length===2);assert.equal(state.room.deadline,deadline);assert.equal(state.game.pot,pot);assert.equal(state.room.summary.length,3);
  a.clear();b.clear();a.send({type:'action',action:'call'});state=await a.next(m=>m.type==='state'&&m.game.turnId===bid);
  a.send({type:'kick',playerId:bid});await b.next(m=>m.type==='kicked');await b.next(m=>m.type==='lobby');state=await a.next(m=>m.type==='state'&&m.game.phase==='ended');
  assert.equal(state.game.players.length,1);assert.equal(state.room.voice.length,0);assert.equal(state.room.deadline,null);assert.equal(state.room.summary.length,3);assert.equal(state.room.summary.reduce((sum,p)=>sum+p.net,0),1500);
  b.send({type:'action',action:'call'});assert.match((await b.next(m=>m.type==='error')).message,/加入房间/);
  b.clear();b.send({type:'join',code});state=await b.next(m=>m.type==='state'&&m.game.players.length===2&&m.game.phase==='ended');assert.equal(state.you,bid);assert.equal(state.room.summary.length,3);assert.equal(state.game.players.find(p=>p.id===bid).chips,state.room.summary.find(p=>p.id===bid).chips);
});

test('主动退房清理语音、保留下注，非当前退出不重置计时，当前房主退出交接并结算',async t=>{
  const login=await membershipServer(t),a=await login('退房房主'),b=await login('退房朋友'),c=await login('接任房主');
  a.send({type:'create',initialChips:500});const created=await a.next(m=>m.type==='state'),code=created.room.code,aid=created.you;
  for(const peer of [b,c]){peer.send({type:'join',code});const s=await peer.next(m=>m.type==='state');peer.id=s.you;}
  for(const peer of [b,c]){peer.send({type:'voice-join'});await peer.next(m=>m.type==='voice-joined');}
  for(const peer of [a,b,c])peer.clear();
  a.send({type:'start'});const initial=await a.next(m=>m.type==='state'&&m.game.phase==='preflop');
  assert.equal(initial.game.turnId,aid);
  b.send({type:'leave'});await b.next(m=>m.type==='lobby');
  let state=await a.next(m=>m.type==='state'&&m.game.players.length===2);
  assert.equal(state.game.turnId,aid);assert.equal(state.room.deadline,initial.room.deadline);assert.equal(state.game.pot,initial.game.pot);
  assert.equal(state.room.summary.find(p=>p.id===b.id).chips,490);assert.deepEqual(state.room.voice.map(p=>p.id),[c.id]);
  assert.ok(state.game.events.some(e=>e==='退房朋友 离开房间，自动弃牌'));
  assert.equal(state.game.events.some(e=>e.includes('被房主')),false);
  const roster=await c.next(m=>m.type==='voice-roster'&&m.peers.length===1);assert.equal(roster.peers[0].id,c.id);
  b.send({type:'join',code,name:'修改昵称重进'});assert.match((await b.next(m=>m.type==='error')).message,/尚未结算/);
  const reopened=await login('退房朋友',b.auth.token);await b.next(m=>m.type==='replaced');
  reopened.send({type:'action',action:'call'});assert.match((await reopened.next(m=>m.type==='error')).message,/加入房间/);
  a.send({type:'leave'});await a.next(m=>m.type==='lobby');
  state=await c.next(m=>m.type==='state'&&m.game.phase==='ended');
  assert.equal(state.room.ownerId,c.id);assert.equal(state.room.deadline,null);assert.deepEqual(state.game.players.map(p=>p.id),[c.id]);
  assert.equal(state.room.summary.reduce((sum,p)=>sum+p.net,0),1500);
  reopened.send({type:'join',code,name:'退房朋友'});state=await reopened.next(m=>m.type==='state');
  assert.equal(state.you,b.id);assert.equal(state.game.players.find(p=>p.id===b.id).chips,490);assert.equal(state.room.summary.length,3);
  reopened.send({type:'leave'});await reopened.next(m=>m.type==='lobby');
  c.send({type:'finish'});await c.next(m=>m.type==='state'&&m.room.finished);
  c.send({type:'leave'});await c.next(m=>m.type==='lobby');
  a.send({type:'join',code});assert.match((await a.next(m=>m.type==='error')).message,/不存在/);
  const health=new URL('/health',a.ws.url.replace('ws:','http:'));assert.equal((await fetch(health).then(r=>r.json())).rooms,0);
});

test('All-in 主动退房仍结算，房主交接跳过已退玩家，转到新房不被旧房状态或清理干扰',async t=>{
  const login=await membershipServer(t),a=await login('All-in退房'),b=await login('中途退房'),c=await login('保留房间');
  a.send({type:'create',initialChips:500});const first=await a.next(m=>m.type==='state'),code=first.room.code,aid=first.you;
  for(const peer of [b,c]){peer.send({type:'join',code});peer.id=(await peer.next(m=>m.type==='state')).you;}
  for(const peer of [a,b,c])peer.clear();a.send({type:'start'});await a.next(m=>m.type==='state'&&m.game.phase==='preflop');
  a.send({type:'action',action:'raise',amount:500});await a.next(m=>m.type==='state'&&m.game.currentBet===500);
  a.send({type:'leave'});await a.next(m=>m.type==='lobby');
  let state=await b.next(m=>m.type==='state'&&m.game.players.length===2);
  assert.equal(state.room.ownerId,b.id);assert.equal(state.game.turnId,b.id);assert.equal(state.room.summary.find(p=>p.id===aid).chips,0);
  a.send({type:'join',code});assert.match((await a.next(m=>m.type==='error')).message,/尚未结算/);
  a.send({type:'create',initialChips:500});const newRoom=(await a.next(m=>m.type==='state')).room.code;a.clear();
  b.send({type:'leave'});await b.next(m=>m.type==='lobby');
  state=await c.next(m=>m.type==='state'&&m.game.players.length===1);
  assert.equal(state.room.ownerId,c.id);assert.equal(state.game.phase,'preflop');assert.equal(state.game.turnId,c.id);
  c.send({type:'action',action:'call'});state=await c.next(m=>m.type==='state'&&m.game.phase==='ended');
  assert.equal(state.game.board.length,5);assert.equal(state.room.summary.length,3);assert.equal(state.room.summary.reduce((sum,p)=>sum+p.net,0),1500);
  assert.ok(state.game.handResults.players.some(p=>p.id===aid));assert.ok(state.game.pots.some(p=>p.winners.includes('All-in退房')||p.winners.includes('保留房间')));
  c.send({type:'leave'});await c.next(m=>m.type==='lobby');
  a.send({type:'join',code:newRoom});state=await a.next(m=>m.type==='state');assert.equal(state.room.code,newRoom);assert.equal(state.game.players.length,1);assert.equal(state.game.players[0].chips,500);
  b.send({type:'join',code});assert.match((await b.next(m=>m.type==='error')).message,/不存在/);
  a.send({type:'leave'});await a.next(m=>m.type==='lobby');
  const health=new URL('/health',a.ws.url.replace('ws:','http:'));assert.equal((await fetch(health).then(r=>r.json())).rooms,0);
});

test('借过筹码的玩家离开后换浏览器同名加入，仍是原账本，借款不能清零',async t=>{
  const login=await membershipServer(t),a=await login('账本甲'),b=await login('账本乙');
  a.send({type:'create',initialChips:500,password:'ledger-password'});const code=(await a.next(m=>m.type==='state')).room.code;b.send({type:'join',code,password:'ledger-password'});await b.next(m=>m.type==='state');await a.next(m=>m.type==='state'&&m.game.players.length===2);
  let state;
  for(let i=0;i<12;i++){
    a.clear();b.clear();a.send({type:'start'});state=await a.next(m=>m.type==='state'&&m.game.phase==='preflop');await b.next(m=>m.type==='state'&&m.game.phase==='preflop');
    const actor=state.game.turnId===state.you?a:b,p=state.game.players.find(p=>p.id===state.game.turnId);actor.send({type:'action',action:'raise',amount:p.bet+p.chips});await a.next(m=>m.type==='state'&&m.game.currentBet===500);await b.next(m=>m.type==='state'&&m.game.currentBet===500);
    (actor===a?b:a).send({type:'action',action:'call'});state=await a.next(m=>m.type==='state'&&m.game.phase==='ended');await b.next(m=>m.type==='state'&&m.game.phase==='ended');if(state.game.players.some(p=>p.chips===0))break;
  }
  const bust=state.game.players.find(p=>p.chips===0);assert.ok(bust);const borrower=bust.id===state.you?a:b,other=borrower===a?b:a;borrower.send({type:'rebuy'});state=await borrower.next(m=>m.type==='state'&&m.room.summary.some(p=>p.borrowed===500));
  borrower.send({type:'leave'});await borrower.next(m=>m.type==='lobby');other.clear();const disconnected=new Promise(resolve=>borrower.ws.once('close',resolve));borrower.ws.terminate();await disconnected;
  const fresh=await login(bust.name);fresh.send({type:'join',code,password:'ledger-password',spectator:true});await fresh.next(m=>m.type==='welcome'&&m.recovered);state=await fresh.next(m=>m.type==='state');
  assert.equal(state.you,bust.id);assert.equal(state.room.summary.length,2);assert.deepEqual(state.room.summary.find(p=>p.id===bust.id),{id:bust.id,name:bust.name,chips:500,borrowed:500,repaid:0,debt:500,net:0});assert.equal(state.game.players.find(p=>p.id===bust.id).chips,500);assert.equal(state.game.players.find(p=>p.id===bust.id).seated,false);assert.equal(state.room.summary.reduce((sum,p)=>sum+p.net,0),1000);
});

test('再次打开网页用原令牌恢复密码房和观战身份，离开或被踢后仅回大厅',async t=>{
  const port=await freePort(),child=spawn(process.execPath,[path.resolve(__dirname,'../server/index.js')],{env:{...testEnvironment(),PORT:String(port),ALLOW_GUEST:'true'},stdio:['ignore','pipe','pipe']});
  const peers=[];t.after(()=>{peers.forEach(c=>c.ws.terminate());child.kill();});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('启动超时')),5000);child.stdout.once('data',()=>{clearTimeout(timer);resolve();});child.once('error',reject);});
  async function login(name,token){const c=client(`ws://127.0.0.1:${port}/ws`);peers.push(c);await c.opened;c.send({type:'hello',name,token});c.auth=await c.next(m=>m.type==='welcome');return c;}
  async function close(c){const closed=new Promise(resolve=>c.ws.once('close',resolve));c.ws.terminate();await closed;}
  const owner=await login('记忆房主'),player=await login('记忆玩家');await owner.next(m=>m.type==='lobby');await player.next(m=>m.type==='lobby');
  owner.send({type:'create',initialChips:500,password:'remember-table'});const code=(await owner.next(m=>m.type==='state')).room.code;
  player.send({type:'join',code,password:'remember-table'});await player.next(m=>m.type==='state');await owner.next(m=>m.type==='state'&&m.game.players.length===2);
  owner.clear();player.clear();owner.send({type:'start'});await owner.next(m=>m.type==='state'&&m.game.phase==='preflop');await player.next(m=>m.type==='state'&&m.game.phase==='preflop');
  owner.send({type:'action',action:'fold'});await player.next(m=>m.type==='state'&&m.game.phase==='ended');
  player.send({type:'stand'});const original=await player.next(m=>m.type==='state'&&m.game.players.some(p=>p.id===m.you&&!p.seated));const originalPlayer=original.game.players.find(p=>p.id===original.you);
  assert.notEqual(originalPlayer.chips,500);
  // A second tab needs only the remembered identity, without the room code or password.
  const second=await login('不会覆盖原昵称',player.auth.token);await player.next(m=>m.type==='replaced');let state=await second.next(m=>m.type==='state');
  assert.equal(second.auth.token,player.auth.token);assert.equal(second.auth.name,'记忆玩家');assert.equal(state.you,original.you);assert.equal(state.room.code,code);assert.equal(state.room.locked,true);
  assert.equal(state.game.players.length,2);assert.deepEqual(state.game.players.find(p=>p.id===state.you),originalPlayer);assert.deepEqual(state.room.summary,original.room.summary);
  await close(second);const reopened=await login('记忆玩家',player.auth.token);state=await reopened.next(m=>m.type==='state');assert.equal(state.you,original.you);assert.equal(state.game.players.find(p=>p.id===state.you).seated,false);assert.equal(state.game.players.find(p=>p.id===state.you).chips,originalPlayer.chips);
  reopened.send({type:'leave'});await reopened.next(m=>m.type==='lobby');await close(reopened);
  const afterLeave=await login('记忆玩家',player.auth.token);await afterLeave.next(m=>m.type==='lobby');afterLeave.send({type:'seat'});assert.match((await afterLeave.next(m=>m.type==='error')).message,/加入房间/);
  // A deliberate later join still restores the ledger, but a kick clears membership again.
  afterLeave.send({type:'join',code,password:'remember-table',spectator:true});state=await afterLeave.next(m=>m.type==='state');assert.equal(state.you,original.you);
  owner.send({type:'kick',playerId:original.you});await afterLeave.next(m=>m.type==='kicked');await afterLeave.next(m=>m.type==='lobby');await close(afterLeave);
  const afterKick=await login('记忆玩家',player.auth.token);await afterKick.next(m=>m.type==='lobby');afterKick.send({type:'seat'});assert.match((await afterKick.next(m=>m.type==='error')).message,/加入房间/);
  assert.equal((await fetch(`http://127.0.0.1:${port}/health`).then(r=>r.json())).rooms,1);
});

test('密码房间拒绝空密码和错误密码，只有房主能更新，原玩家可重连',async t=>{
  const port=await freePort();const child=spawn(process.execPath,[path.resolve(__dirname,'../server/index.js')],{env:{...testEnvironment(),PORT:String(port),ALLOW_GUEST:'true'},stdio:['ignore','pipe','pipe']});
  const clients=[];t.after(()=>{clients.forEach(c=>c.ws.terminate());child.kill();});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('启动超时')),5000);child.stdout.once('data',()=>{clearTimeout(timer);resolve();});child.once('error',reject);});
  async function login(name,token){const c=client(`ws://127.0.0.1:${port}/ws`);clients.push(c);await c.opened;c.send({type:'hello',name,token});c.auth=await c.next(m=>m.type==='welcome');return c;}
  const a=await login('房主'),b=await login('朋友');await a.next(m=>m.type==='lobby');await b.next(m=>m.type==='lobby');
  a.send({type:'create',initialChips:500,password:'12'});assert.match((await a.next(m=>m.type==='error')).message,/4～32/);
  a.send({type:'create',initialChips:500,password:'private-table-42'});const first=await a.next(m=>m.type==='state');const code=first.room.code;assert.equal(first.room.locked,true);assert.equal(JSON.stringify(first).includes('private-table-42'),false);assert.equal('protection' in first.room,false);
  for(const password of [undefined,'wrong-password']){b.send({type:'join',code,password});assert.match((await b.next(m=>m.type==='error')).message,/密码不正确/);}
  b.send({type:'join',code,password:'private-table-42'});await b.next(m=>m.type==='state');await a.next(m=>m.type==='state'&&m.game.players.length===2);
  b.send({type:'password',password:''});assert.match((await b.next(m=>m.type==='error')).message,/只有房主/);
  a.send({type:'password',password:'new-password-99'});await a.next(m=>m.type==='room-settings-saved');await a.next(m=>m.type==='state');await b.next(m=>m.type==='state');
  b.ws.terminate();const recovered=await login('朋友',b.auth.token);assert.equal((await recovered.next(m=>m.type==='state')).room.code,code);
  recovered.send({type:'leave'});await recovered.next(m=>m.type==='lobby');await a.next(m=>m.type==='state'&&m.game.players.length===1);
  recovered.send({type:'join',code,password:'private-table-42'});assert.match((await recovered.next(m=>m.type==='error')).message,/密码不正确/);
  recovered.send({type:'join',code,password:'new-password-99'});await recovered.next(m=>m.type==='state');await a.next(m=>m.type==='state'&&m.game.players.length===2);
  a.send({type:'password',password:''});await a.next(m=>m.type==='room-settings-saved');assert.equal((await a.next(m=>m.type==='state'&&!m.room.locked)).room.locked,false);await recovered.next(m=>m.type==='state'&&!m.room.locked);recovered.clear();
  recovered.send({type:'leave'});await recovered.next(m=>m.type==='lobby');recovered.send({type:'join',code});assert.equal((await recovered.next(m=>m.type==='state')).room.locked,false);
});

test('连续猜测房间密码受到限流且不能加入',async t=>{
  const port=await freePort();const child=spawn(process.execPath,[path.resolve(__dirname,'../server/index.js')],{env:{...testEnvironment(),PORT:String(port),ALLOW_GUEST:'true'},stdio:['ignore','pipe','pipe']});
  const clients=[];t.after(()=>{clients.forEach(c=>c.ws.terminate());child.kill();});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('启动超时')),5000);child.stdout.once('data',()=>{clearTimeout(timer);resolve();});child.once('error',reject);});
  const a=client(`ws://127.0.0.1:${port}/ws`),b=client(`ws://127.0.0.1:${port}/ws`);clients.push(a,b);await Promise.all([a.opened,b.opened]);
  for(const c of [a,b]){c.send({type:'hello',name:'测试玩家'});await c.next(m=>m.type==='welcome');await c.next(m=>m.type==='lobby');}
  a.send({type:'create',initialChips:500,password:'real-password'});const code=(await a.next(m=>m.type==='state')).room.code;
  for(let i=0;i<5;i++){b.send({type:'join',code,password:'wrong'});assert.match((await b.next(m=>m.type==='error')).message,/密码不正确/);}
  b.send({type:'join',code,password:'real-password'});assert.match((await b.next(m=>m.type==='error')).message,/一分钟/);
});
