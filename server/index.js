const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const envPath=path.resolve(__dirname,'../.env');
if(fs.existsSync(envPath))process.loadEnvFile(envPath);
const {WebSocketServer,WebSocket}=require('ws');
const {Game}=require('./poker');
const {protectRoom,matchesPassword}=require('./room-password');
const {TableLedger}=require('./table-ledger');
const {nameKey}=require('./player-name');
const {AdminAccess}=require('./admin-access');
const {VoiceRooms}=require('./voice-room');
const {VoiceAudioLimit}=require('./voice-audio-limit');
const {SeatShuffleVote}=require('./seat-shuffle');
const {RoomReactions}=require('./reactions');
const admin=new AdminAccess({username:process.env.ADMIN_USERNAME,password:process.env.ADMIN_PASSWORD,file:path.resolve(process.env.ADMIN_DATA_FILE||path.join(__dirname,'../.data/admin-access.json')),initialCode:process.env.ROOM_CREATE_CODE});
const {createWechatExchange,SessionStore,AuthError}=require('./wechat-auth');
const store=new SessionStore(),rooms=new Map(),sessions=store.sessions;
const reactions=new RoomReactions({sessions,send});
const seatShuffle=new SeatShuffleVote({sessions,onChange:room=>broadcast(room)});
const voice=new VoiceRooms({send,sessions,transport:process.env.VOICE_TRANSPORT==='webrtc'?'webrtc':'relay',iceServers:JSON.parse(process.env.VOICE_ICE_SERVERS||'[{"urls":"stun:stun.cloudflare.com:3478"}]')});
const exchangeWechat=createWechatExchange({appid:process.env.WECHAT_APP_ID,secret:process.env.WECHAT_APP_SECRET});
const allowGuest=process.env.ALLOW_GUEST!=='false';
const loginLimits=new Map();
const PORT=Number(process.env.PORT)||3000;
const webRoot=path.resolve(__dirname,'../web');
function json(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
function readBody(req){return new Promise((resolve,reject)=>{let body='',bytes=0,failed=false;req.on('data',chunk=>{bytes+=chunk.length;if(bytes>4096){if(!failed){failed=true;reject(new AuthError('登录请求过大',413));}return;}body+=chunk;});req.on('end',()=>{if(failed)return;try{resolve(JSON.parse(body));}catch{reject(new AuthError('请求格式错误',400));}});req.on('error',()=>reject(new AuthError('请求中断',400)));});}
const server=http.createServer(async(req,res)=>{
  const pathname=new URL(req.url,'http://localhost').pathname;
  if(pathname==='/api/room-policy'&&req.method==='GET'){json(res,200,{requireCode:admin.requireCode});return;}
  if(pathname.startsWith('/api/admin/')){
    try{
      if(req.method!=='GET'&&req.method!=='POST')throw new AuthError('请求方法无效',405);
      if(req.headers.origin&&new URL(req.headers.origin).host!==req.headers.host)throw new AuthError('请求来源无效',403);
      const token=(req.headers.cookie||'').split(';').map(p=>p.trim()).find(p=>p.startsWith('poker_admin='))?.slice(12);
      const cookie=value=>res.setHeader('Set-Cookie',`poker_admin=${value}; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=${value?28800:0}${process.env.NODE_ENV==='production'?'; Secure':''}`);
      if(req.method==='GET'){
        if(pathname!=='/api/admin/status')throw new AuthError('接口不存在',404);
        if(!admin.authenticated(token))throw new AuthError('请登录管理员账号',401);
        json(res,200,admin.status());return;
      }
      if(!(req.headers['content-type']||'').startsWith('application/json'))throw new AuthError('请求必须为 JSON',415);
      if(pathname!=='/api/admin/login'&&!admin.authenticated(token))throw new AuthError('请登录管理员账号',401);
      const body=await readBody(req);if(!body||typeof body!=='object'||Array.isArray(body))throw new AuthError('请求格式错误',400);
      if(pathname==='/api/admin/login'){
        const session=admin.login(body.username,body.password,req.socket.remoteAddress);cookie(session);json(res,200,admin.status());
      }else if(pathname==='/api/admin/logout'){admin.logout(token);cookie('');json(res,200,{ok:true});}
      else if(pathname==='/api/admin/policy')json(res,200,admin.setPolicy(body));
      else if(pathname==='/api/admin/code')json(res,200,admin.setCode(body));
      else throw new AuthError('接口不存在',404);
    }catch(error){json(res,error.status||400,{message:error.message||'管理员操作失败'});}
    return;
  }
  if(pathname==='/api/auth/wechat') {
    try {
      if(req.method!=='POST')throw new AuthError('请使用 POST 请求',405);
      if(!(req.headers['content-type']||'').startsWith('application/json'))throw new AuthError('请求必须为 JSON',415);
      const ip=req.socket.remoteAddress,now=Date.now();
      let limit=loginLimits.get(ip);if(!limit||now-limit.since>=60000){if(!limit&&loginLimits.size>=4096)throw new AuthError('登录服务繁忙',503);limit={since:now,count:0};loginLimits.set(ip,limit);}
      if(++limit.count>20)throw new AuthError('登录太频繁，请稍后重试',429);
      const body=await readBody(req);if(!body||typeof body!=='object')throw new AuthError('请求格式错误',400);
      const nickname=name(body.name),openid=await exchangeWechat(body.code),s=store.wechat(openid,nickname);
      json(res,200,{token:s.token,expiresAt:s.expiresAt,user:{id:s.id,name:s.name,loginType:'wechat'}});
    } catch(error){json(res,error.status||400,{message:error instanceof AuthError?error.message:'昵称无效，请输入 1～12 字的昵称',code:error.code||'BAD_REQUEST'});}
    return;
  }
  const files={'/':'index.html','/app.js':'app.js','/style.css':'style.css','/room-theme.css':'room-theme.css','/admin':'admin.html','/admin.js':'admin.js','/voice.js':'voice.js','/voice-relay.js':'voice-relay.js','/voice-capture.js':'voice-capture.js','/table-controls.js':'table-controls.js','/round-display.js':'round-display.js','/player-memory.js':'player-memory.js','/reactions.js':'reactions.js','/reactions.css':'reactions.css'};
  if(process.env.VOICE_TEST_MODE==='true'&&process.env.NODE_ENV!=='production')files['/voice-self-test']='voice-self-test.html';
  if(pathname==='/health') { res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true,rooms:rooms.size})); return; }
  if(!files[pathname]) {res.writeHead(404);res.end('Not found');return;}
  res.writeHead(200,{'Content-Type':pathname.endsWith('.js')?'text/javascript; charset=utf-8':pathname.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8','X-Content-Type-Options':'nosniff','Cache-Control':'no-cache'});
  fs.createReadStream(path.join(webRoot,files[pathname])).pipe(res);
});
const wss=new WebSocketServer({server,path:'/ws',maxPayload:16384});
function send(ws,data) { if(ws?.readyState===WebSocket.OPEN) ws.send(JSON.stringify(data)); }
function broadcast(room) {
  seatShuffle.validate(room);
  for(const p of room.game.players) {
    const s=sessions.get(p.id); if(p.pendingRemove||!s?.ws||s.room!==room.code) continue;
    send(s.ws,{type:'state',room:{code:room.code,ownerId:room.ownerId,deadline:room.deadline,locked:!!room.protection,finished:room.finished,seatVote:room.seatVote||null,summary:room.finalSummary||room.ledger.summary(),voice:voice.members(room)},you:p.id,
      game:{...room.game.snapshot(p.id),players:room.game.snapshot(p.id).players.map(q=>({...q,online:sessions.get(q.id)?.room===room.code&&sessions.get(q.id)?.ws?.readyState===WebSocket.OPEN}))}});
  }
}
function schedule(room) {
  clearTimeout(room.timer); room.deadline=null;
  if(!room.game.playing())for(const p of room.game.players)if(p.pendingStand)room.game.stand(p.id);
  room.game.pruneRemoved();
  if(room.game.playing()&&room.game.turn!==null) {
    room.deadline=Date.now()+45000;
    room.timer=setTimeout(()=>{
      const actor=room.game.players[room.game.turn];
      if(!actor) return;
      room.game.action(actor.id,room.game.currentBet>actor.bet?'fold':'check');
      schedule(room);broadcast(room);
    },45000);
  }
  room.updated=Date.now();
}
function code() { let c; do {c=String(crypto.randomInt(100000,1000000));} while(rooms.has(c)); return c; }
function name(value) { if(typeof value!=='string'||!value.trim()||value.trim().length>12) throw Error('请输入 1～12 字的昵称'); return value.trim().replace(/[\u0000-\u001f]/g,''); }
wss.on('connection',(ws,req)=>{
  let session=null, windowStart=Date.now(), messages=0,voiceMessages=0;
  const audioLimit=new VoiceAudioLimit();
  ws.alive=true; ws.on('pong',()=>ws.alive=true);
  ws.on('message',buffer=>{
    let msg;
    try {
      msg=JSON.parse(buffer.toString());
      if(!msg||typeof msg!=='object') throw Error('请求格式错误');
      if(Date.now()-windowStart>1000) {windowStart=Date.now();messages=0;voiceMessages=0;}
      if(msg.type==='voice-audio'){if(!audioLimit.allow())return;}
      else if(msg.type==='voice-signal'){if(++voiceMessages>120)throw Error('语音信令过于频繁');}
      else if(++messages>20) throw Error('操作太频繁，请稍后再试');
      if(msg.type==='hello') {
        if(session) throw Error('已连接');
        const previous=store.fromToken(msg.token);
        if((msg.platform==='wechat'||!allowGuest)&&(!previous||previous.kind!=='wechat'))throw new AuthError('微信登录已过期，请重新登录',401,'AUTH_EXPIRED');
        if(previous) {
          session=previous;
          voice.leave(rooms.get(session.room),session);
          const old=session.ws; session.ws=ws;
          if(old&&old!==ws) { send(old,{type:'replaced',message:'此身份已在另一个窗口登录'}); old.close(); }
        } else {
          session=store.create(name(msg.name));session.ws=ws;
        }
        send(ws,{type:'welcome',token:session.token,name:session.name,loginType:session.kind,expiresAt:session.expiresAt});
        if(session.room&&rooms.has(session.room)) broadcast(rooms.get(session.room));
        else {session.room=null;send(ws,{type:'lobby'});}
        return;
      }
      if(!session||session.ws!==ws) throw Error('请先连接');
      if(session.expiresAt<=Date.now())throw new AuthError('登录已过期，请重新登录',401,'AUTH_EXPIRED');
      session.updated=Date.now();
      let room=session.room?rooms.get(session.room):null;
      if(msg.type==='reaction'){reactions.react(room,session,msg);return;}
      if(msg.type==='create'||msg.type==='join') {
        if(room&&msg.type==='join'&&room.code===String(msg.code)&&nameKey(name(msg.name??session.name))===nameKey(session.name)){broadcast(room);return;}
        if(room) throw Error('你已在房间内，请先离开');
        if(msg.name!==undefined) session.name=name(msg.name);
        if(msg.type==='create') {
          if(rooms.size>=500) throw Error('房间数量已达上限');
          const protection=protectRoom(msg.password);
          const game=new Game({smallBlind:msg.smallBlind??5,bigBlind:msg.bigBlind??10,ante:0,initialChips:msg.initialChips});
          admin.consume(msg.authorizationCode,req.socket.remoteAddress);
          const c=code();room={code:c,ownerId:session.id,game,timer:null,deadline:null,seatVote:null,seatVoteTimer:null,updated:Date.now(),protection,ledger:new TableLedger({initialChips:game.initialChips}),finished:false};rooms.set(c,room);
        } else {
          const now=Date.now();
          if(!session.joinLimit||now-session.joinLimit.since>=60000)session.joinLimit={since:now,count:0};
          if(session.joinLimit.count>=5)throw Error('加入失败次数过多，请一分钟后再试');
          room=rooms.get(String(msg.code));
          if(!room){session.joinLimit.count++;throw Error('房间不存在或已过期');}
          if(!matchesPassword(room.protection,msg.password)){session.joinLimit.count++;throw Error('房间密码不正确，请向房主确认');}
          session.joinLimit.count=0;
        }
        if(room.finished)throw Error('这张牌桌已结束，请创建新房间');
        const matching=room.game.players.find(p=>nameKey(p.name)===nameKey(session.name))||[...room.ledger.records.values()].find(r=>nameKey(r.player.name)===nameKey(session.name))?.player;
        if((matching?.pendingRemove&&room.game.players.includes(matching))||room.game.players.some(p=>p.id===session.id&&p.pendingRemove))throw Error('你上一手牌尚未结算，请等本局结束后再加入');
        if(matching&&matching.id!==session.id){
          if(room.ledger.records.has(session.id))throw Error('此浏览器已有筹码记录，请使用原昵称，不能切换为其他玩家');
          const previous=sessions.get(matching.id);
          if(!previous||previous.kind!=='guest'||session.kind!=='guest')throw Error('此昵称已使用，请用原账号登录或选择其他昵称');
          if(previous.ws?.readyState===WebSocket.OPEN)throw Error('同名玩家仍在线，请先关闭原窗口后重试');
          if(previous.room&&previous.room!==room.code)throw Error('此昵称的原玩家正在其他房间，请使用其他昵称');
          if(room.ownerId===previous.id&&!room.protection)throw Error('恢复公开房间的房主身份，请使用原浏览器登录');
          voice.leave(room,previous);session.ws=null;store.remove(session);session=previous;store.rotate(session);session.ws=ws;session.updated=Date.now();
          send(ws,{type:'welcome',token:session.token,loginType:session.kind,expiresAt:session.expiresAt,recovered:true,name:matching.name});
        }
        const existing=room.game.players.find(p=>p.id===session.id);
        if(!existing){room.game.addPlayer(session.id,matching?.name||session.name,msg.spectator!==true);const added=room.game.players.at(-1);if(added.seated||room.ledger.records.has(added.id))room.ledger.seat(added);}
        session.name=matching?.name||session.name;session.room=room.code;room.updated=Date.now();broadcast(room);return;
      }
      if(!room) throw Error('请先创建或加入房间');
      if(seatShuffle.validate(room))broadcast(room);
      if(['voice-join','voice-leave','voice-mute','voice-signal','voice-audio'].includes(msg.type)){
        try{
          if(msg.type==='voice-join'){if(voice.transport==='relay'&&msg.relaySupported!==true)throw Error('语音已更新，请刷新页面后重新加入');voice.join(room,session);}
          else if(msg.type==='voice-leave'){voice.leave(room,session);send(ws,{type:'voice-left'});}
          else if(msg.type==='voice-mute')voice.mute(room,session,msg.muted);
          else if(msg.type==='voice-audio')voice.audio(room,session,msg.data);
          else voice.signal(room,session,msg.to,msg.data);
        }catch(error){send(ws,{type:'voice-error',operation:msg.type,message:error.message});}
        return;
      }
      if(msg.type==='blinds'){if(room.finished)throw Error('牌桌已结束');if(room.ownerId!==session.id)throw Error('只有房主可以修改盲注');room.game.setBlinds(msg.smallBlind,msg.bigBlind);room.updated=Date.now();send(ws,{type:'blind-settings-saved'});broadcast(room);return;}
      if(msg.type==='password') {
        if(room.ownerId!==session.id)throw Error('只有房主可以修改房间密码');
        room.protection=protectRoom(msg.password);room.updated=Date.now();
        send(ws,{type:'room-settings-saved'});broadcast(room);return;
      }
      if(msg.type==='kick'){
        if(room.ownerId!==session.id)throw Error('只有房主可以移出玩家');
        if(msg.playerId===session.id)throw Error('不能移出自己，请使用离开房间');
        const target=room.game.players.find(p=>p.id===msg.playerId&&!p.pendingRemove);
        if(!target)throw Error('玩家已离开房间');
        const beforeTurn=room.game.players[room.game.turn]?.id,beforePhase=room.game.phase;
        const removedSession=sessions.get(target.id);
        room.game.removePlayer(target.id);
        if(removedSession?.room===room.code){voice.leave(room,removedSession);removedSession.room=null;send(removedSession.ws,{type:'kicked',message:'房主已将你移出房间，筹码与借款记录保留'});send(removedSession.ws,{type:'lobby'});}
        if(beforeTurn!==room.game.players[room.game.turn]?.id||beforePhase!==room.game.phase)schedule(room);else room.updated=Date.now();
        send(ws,{type:'player-kicked',name:target.name});broadcast(room);return;
      }
      if(msg.type==='leave') {
        const beforeTurn=room.game.players[room.game.turn]?.id,beforePhase=room.game.phase;
        room.game.removePlayer(session.id,{reason:'leave'});
        voice.leave(room,session);
        session.room=null;send(ws,{type:'lobby'});
        const remaining=room.game.players.filter(p=>!p.pendingRemove&&sessions.get(p.id)?.room===room.code);
        if(!remaining.length) {clearTimeout(room.timer);seatShuffle.clear(room);room.deadline=null;rooms.delete(room.code);}
        else {
          if(room.ownerId===session.id)room.ownerId=(remaining.find(p=>sessions.get(p.id)?.ws?.readyState===WebSocket.OPEN)||remaining[0]).id;
          if(beforeTurn!==room.game.players[room.game.turn]?.id||beforePhase!==room.game.phase)schedule(room);else room.updated=Date.now();
          broadcast(room);
        }
        return;
      }
      if(msg.type==='reveal') {
        room.game.reveal(session.id,msg.hand);room.updated=Date.now();broadcast(room);return;
      }
      if(room.finished)throw Error('牌桌已结束，总计已保存；继续玩请创建新房间');
      if(msg.type==='shuffle-request')seatShuffle.request(room,session.id);
      else if(msg.type==='shuffle-vote')seatShuffle.vote(room,session.id,msg.voteId,msg.agree);
      else if(msg.type==='shuffle-cancel')seatShuffle.cancel(room,session.id,msg.voteId);
      else if(msg.type==='stand') {
        const turn=room.game.turn,phase=room.game.phase;room.game.stand(session.id);
        if(turn!==room.game.turn||phase!==room.game.phase)schedule(room);else room.updated=Date.now();
      }
      else if(msg.type==='seat') {
        const p=room.game.players.find(p=>p.id===session.id);
        if(p.seated)throw Error('你已在座位上');
        if(room.game.playing()&&(p.inHand||p.total>0))throw Error('请等当前参与的本局结束后重新入座');
        if(room.game.players.filter(p=>p.seated).length>=9)throw Error('座位已满（最多 9 人）');
        if(!room.ledger.records.has(p.id))p.chips=room.game.initialChips;
        room.ledger.seat(p);p.seated=true;room.game.log(`${p.name} 入座${room.game.playing()?'，下一局参与':''}`);room.updated=Date.now();
      }
      else if(msg.type==='finish') {
        if(room.ownerId!==session.id)throw Error('只有房主可以结束牌桌');
        if(room.game.playing())throw Error('请等待本局结束后再结束牌桌');
        clearTimeout(room.timer);room.deadline=null;room.finished=true;room.finalSummary=room.ledger.summary();room.updated=Date.now();
      }
      else if(msg.type==='start') {if(room.ownerId!==session.id) throw Error('只有房主可以开始');if(room.seatVote)throw Error('换位投票进行中，请等待结果或先取消投票');room.game.start();schedule(room);}
      else if(msg.type==='action') {room.game.action(session.id,msg.action,msg.amount);schedule(room);}
      else if(msg.type==='rebuy') {
        room.ledger.borrow(room.game,session.id);room.updated=Date.now();
      } else if(msg.type==='repay') {
        const amount=room.ledger.repay(room.game,session.id,msg.amount,msg.requestId);room.updated=Date.now();
        send(ws,{type:'repaid',requestId:msg.requestId,amount});
      } else throw Error('未知请求');
      broadcast(room);
    } catch(error) {send(ws,msg?.type==='reaction'?{type:'reaction-error',message:error.message||'表情发送失败',...(error.retryAfterMs?{retryAfterMs:error.retryAfterMs}:{})}:{type:'error',message:error.message||'请求失败',code:error.code});}
  });
  ws.on('close',()=>{if(session?.ws===ws) {session.ws=null;session.updated=Date.now();const room=rooms.get(session.room);voice.leave(room,session);if(room) broadcast(room);}});
  ws.on('error',()=>{});
});
const heartbeat=setInterval(()=>{
  for(const ws of wss.clients) {if(!ws.alive) {ws.terminate();continue;} ws.alive=false;ws.ping();}
  for(const [c,r] of rooms) if(Date.now()-r.updated>6*60*60*1000) {clearTimeout(r.timer);seatShuffle.clear(r); for(const p of r.game.players) {const s=sessions.get(p.id);if(s?.room===c){voice.leave(r,s);s.room=null;if(s.ws)send(s.ws,{type:'lobby'});}} rooms.delete(c);}
  for(const s of sessions.values()) if(!s.ws&&!s.room&&Date.now()-s.updated>24*60*60*1000)store.remove(s);
  for(const [ip,limit] of loginLimits)if(Date.now()-limit.since>=60000)loginLimits.delete(ip);
},30000);
server.listen(PORT,()=>console.log(`朋友牌桌已启动：http://localhost:${PORT}`));
function shutdown() {clearInterval(heartbeat);for(const r of rooms.values()){clearTimeout(r.timer);seatShuffle.clear(r);}wss.clients.forEach(ws=>ws.terminate());wss.close();server.close();}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
