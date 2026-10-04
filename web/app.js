const $=id=>document.getElementById(id);
let socket, state=null, intent=null, reconnectTimer, manualStop=false, welcomed=false, reconnectAttempt=0;
let requireCreationCode=false,raiseKey='',blindKey='',currentPage=0,previousBets=null,kickTarget=null,leaveTarget=null;
let bankRequest=null,bankMode="borrow",bankDraftKey="";
let revealRequest=null;
let allinTarget=null;
let shufflePending=null,shownSeatVote=null,previousSeatVote=null;
const roundDisplay=new RoundDisplay();let roundDisplayTimer;
function resetRoundDisplay(){roundDisplay.reset();clearTimeout(roundDisplayTimer);}
function fitRoom(){
  const width=Math.round(window.visualViewport?.width||window.innerWidth),height=Math.round(window.visualViewport?.height||window.innerHeight);
  const coarse=window.matchMedia('(pointer:coarse)').matches;
  const portrait=coarse&&screen.orientation?.type?screen.orientation.type.startsWith('portrait'):window.innerHeight>window.innerWidth;
  const rotated=portrait&&(coarse||window.innerWidth<=600);
  document.body.classList.toggle('landscape-rotated',rotated);
  document.body.classList.toggle('compact-table',Math.min(width,height)<=500||Math.max(width,height)<900);
  document.body.classList.toggle('small-table',Math.max(width,height)<=700);
  document.body.classList.toggle('short-table',Math.min(width,height)<=340);
  const style=document.documentElement.style;
  style.setProperty('--viewport-height',height+'px');style.setProperty('--room-width',(rotated?height:width)+'px');style.setProperty('--room-height',(rotated?width:height)+'px');
}
fitRoom();window.addEventListener('resize',fitRoom);window.visualViewport?.addEventListener('resize',fitRoom);
const gameSounds=new PokerSounds();
const pageNames=['table','records','tools'];
function showPage(index){currentPage=(index+3)%3;pageNames.forEach((name,i)=>{$('page-'+name).hidden=i!==currentPage;$('tab-'+name).setAttribute('aria-selected',String(i===currentPage));});tableReactions.onLayout();}
for(const [i,name] of pageNames.entries())$('tab-'+name).onclick=()=>showPage(i);
$('page-prev').onclick=()=>showPage(currentPage-1);$('page-next').onclick=()=>showPage(currentPage+1);
document.querySelector('.room-top').insertBefore(document.querySelector('.room-nav'),document.querySelector('.room-top .room-tools'));
async function leaveFullscreen(){
  try{if(document.fullscreenElement)await document.exitFullscreen();}catch{}
  try{screen.orientation?.unlock?.();}catch{}
}
$('fullscreen').onclick=async()=>{
  if(document.fullscreenElement){await leaveFullscreen();return;}
  if(!document.documentElement.requestFullscreen){toast('请横握手机；当前浏览器暂不支持网页全屏');return;}
  try{await document.documentElement.requestFullscreen();try{await screen.orientation?.lock?.('landscape');}catch{}}catch{toast('请横握手机；当前浏览器未允许全屏');}
};
document.addEventListener('fullscreenchange',()=>{$('fullscreen').setAttribute('aria-pressed',String(!!document.fullscreenElement));$('fullscreen').textContent=document.fullscreenElement?'⛶ 退出全屏':'⛶ 全屏';fitRoom();});
for(const id of ['settings','stand','seat'])$('management-buttons').append($(id));
for(const id of ['finish'])$('management-buttons').append($(id));
let swipeStart;document.querySelector('.room-pages').addEventListener('touchstart',e=>{if(e.target.closest('button,input,a,table'))return;swipeStart={x:e.changedTouches[0].clientX,y:e.changedTouches[0].clientY};},{passive:true});
document.querySelector('.room-pages').addEventListener('touchend',e=>{if(!swipeStart)return;const physicalX=e.changedTouches[0].clientX-swipeStart.x,physicalY=e.changedTouches[0].clientY-swipeStart.y,rotated=document.body.classList.contains('landscape-rotated'),dx=rotated?physicalY:physicalX,dy=rotated?-physicalX:physicalY;swipeStart=null;if(Math.abs(dx)>70&&Math.abs(dx)>Math.abs(dy)*1.5)showPage(currentPage+(dx<0?1:-1));},{passive:true});
document.addEventListener('pointerdown',()=>gameSounds.unlock(),{capture:true});
document.addEventListener('keydown',()=>gameSounds.unlock(),{capture:true});
$('sound-enabled').onchange=()=>{gameSounds.enabled=$('sound-enabled').checked;};
async function loadPolicy(){try{const r=await fetch('/api/room-policy',{cache:'no-store'});if(!r.ok)return;const p=await r.json();requireCreationCode=p.requireCode;$('authorization-fields').hidden=!requireCreationCode;}catch{}}
loadPolicy();window.addEventListener('focus',loadPolicy);
const voiceChat=new VoiceChat({root:$('voice-panel'),getState:()=>state,send,notice:toast});
const tableReactions=new TableReactions({getState:()=>state,isConnected:()=>welcomed&&socket?.readyState===WebSocket.OPEN,send,notice:toast});
const playerMemory=new PlayerMemory(window);
const storedPlayer=playerMemory.read();if(storedPlayer.name)$('nickname').value=storedPlayer.name;
const invited=new URLSearchParams(location.search).get('room');if(invited)$('roomcode').value=invited;
function toast(message){$('toast').textContent=message;$('toast').hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('toast').hidden=true,4000);}
function send(data){if(data.type==='action'&&roundDisplay.settling){toast('正在发牌，请稍候');return;}if(data.type==='voice-audio'&&socket?.bufferedAmount>16384)return;if(socket?.readyState!==WebSocket.OPEN||!welcomed){toast('连接尚未就绪，请稍候');return;}socket.send(JSON.stringify(data));}
function connect(){
  tableReactions.reset();
  clearTimeout(reconnectTimer);welcomed=false;syncTurnIndicator();manualStop=false;gameSounds.previous=null;resetRoundDisplay();
  if(socket&&socket.readyState!==WebSocket.CLOSED){socket.onclose=null;socket.close();}
  $('connection').textContent='正在连接牌桌服务…';
  socket=new WebSocket(`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}/ws`);
  socket.onopen=()=>{ $('connection').textContent='正在连接';socket.send(JSON.stringify({type:'hello',token:playerMemory.read().token,name:$('nickname').value.trim()})); };
  socket.onmessage=e=>{const m=JSON.parse(e.data);
    if(m.type==='welcome'){welcomed=true;reconnectAttempt=0;playerMemory.save({token:m.token,name:m.name||$('nickname').value.trim()});$('connection').textContent='● 已连接';if(m.name)$('nickname').value=m.name;if(m.recovered)toast('已恢复原玩家，筹码与借款记录保留');}
    else if(m.type==='lobby'){tableReactions.reset();resetRoundDisplay();voiceChat.leave(false);if(state)leaveFullscreen();closeAllin();resetSeatVote();state=null;syncTurnIndicator();kickTarget=null;leaveTarget=null;bankRequest=null;revealRequest=null;for(const id of ['kick-dialog','room-settings','finish-dialog','leave-dialog','bank-dialog'])if($(id).open)$(id).close();document.body.classList.remove('in-room');gameSounds.previous=null;previousBets=null;raiseKey='';blindKey='';showPage(0);loadPolicy();$('lobby').hidden=false;$('room').hidden=true;if(intent){const next=intent;intent=null;send(next);}}
    else if(m.type==='state'){intent=null;const previouslyFinished=state?.room.finished;if(!state){const me=m.game.players.find(p=>p.id===m.you);if(me){$('nickname').value=me.name;playerMemory.save({name:me.name});}if(invited&&invited!==m.room.code)toast('已回到房间 '+m.room.code+'；加入其他房间请先离开当前房间');}state=m;gameSounds.update(m);if(m.room.finished&&!previouslyFinished)showPage(1);voiceChat.update(m.room.voice);render();}
    else if(m.type==='reaction'){tableReactions.receive(m);}
    else if(m.type==='reaction-error'){tableReactions.error(m);}
    else if(m.type.startsWith('voice-')){voiceChat.handle(m).catch(()=>toast('语音连接失败，请退出语音后重试'));}
    else if(m.type==='blind-settings-saved'){toast('盲注已保存，下一手生效；开局仅收小盲和大盲');}
    else if(m.type==='room-settings-saved'){$('room-settings').close();$('settings-password').value='';toast('房间设置已保存');}
    else if(m.type==='kicked'){intent=null;voiceChat.leave(false);toast(m.message);}
    else if(m.type==='player-kicked'){toast('已移出 '+m.name+'，筹码记录已保留');}
    else if(m.type==='error'){intent=null;shufflePending=null;renderSeatVote();bankRequest=null;revealRequest=null;renderBank();renderReveal();if(m.message?.includes('授权码'))loadPolicy();toast(m.message);}
    else if(m.type==='replaced'){tableReactions.reset();manualStop=true;welcomed=false;syncTurnIndicator();closeAllin();shufflePending=null;renderSeatVote();toast(m.message);}
  };
  socket.onclose=()=>{tableReactions.reset();voiceChat.leave(false);welcomed=false;shufflePending=null;renderSeatVote();bankRequest=null;revealRequest=null;$('connection').textContent=manualStop?'此身份已在其他窗口连接':'连接中断，正在重试…';disableActions();if(!manualStop){const delay=Math.min(15000,1000*2**Math.min(reconnectAttempt++,4))+Math.random()*500;reconnectTimer=setTimeout(connect,delay);}};
  socket.onerror=()=>{};
}
async function enter(type){if(type==='create')await loadPolicy();const name=$('nickname').value.trim();if(!name||name.length>12){toast('请输入 1～12 字的昵称');return;}const code=$('roomcode').value.trim();if(type==='join'&&!/^\d{6}$/.test(code)){toast('请输入六位数字房间号');$('roomcode').focus();return;}if(type==='create'&&!/^\d{4}$/.test($('create-authorization').value)){toast('请输入四位创建认证码');$('create-authorization').focus();return;}const password=type==='create'?($('create-locked').checked?$('create-password').value:''):$('join-password').value;if(type==='create'&&$('create-locked').checked&&(password.length<4||password.length>32)){toast('请设置 4～32 个字符的房间密码');$('create-password').focus();return;}const initialChips=Number($('create-chips').value),smallBlind=Number($('create-small').value),bigBlind=Number($('create-big').value);if(type==='create'&&(!Number.isSafeInteger(initialChips)||initialChips<1||initialChips>1000000)){toast('初始筹码须为 1～1,000,000 的整数');$('create-chips').focus();return;}if(type==='create'&&(!Number.isSafeInteger(smallBlind)||!Number.isSafeInteger(bigBlind)||smallBlind<1||bigBlind<smallBlind||bigBlind>2000)){toast('盲注须为整数：1 ≤ 小盲 ≤ 大盲 ≤ 2,000');document.querySelector('.entry-options').open=true;return;}playerMemory.save({name});const request=type==='create'?{type,name,password,smallBlind,bigBlind,initialChips,authorizationCode:$('create-authorization').value}:{type,name,code,password,spectator:$('join-spectator').checked};if(socket?.readyState===WebSocket.OPEN&&welcomed)send(request);else{intent=request;connect();}}
$('create').onclick=()=>enter('create');$('join').onclick=()=>enter('join');
function selectPane(pane){$('create-pane').hidden=pane!=='create';$('join-pane').hidden=pane!=='join';for(const id of ['create','join'])$('tab-'+id).setAttribute('aria-selected',String(pane===id));}
$('tab-create').onclick=()=>selectPane('create');$('tab-join').onclick=()=>selectPane('join');
$('create-chips').oninput=()=>{const value=Number($('create-chips').value);$('initial-chips-preview').textContent=Number.isSafeInteger(value)&&value>0&&value<=1000000?value.toLocaleString():'待设置';};
$('create-locked').onchange=()=>{$('create-password').disabled=!$('create-locked').checked;};
for(const id of ['create-small','create-big'])$(id).addEventListener('input',()=>{$('blind-preview').textContent=$('create-small').value+' / '+$('create-big').value;});
if(invited)selectPane('join');
const suitPaths={s:'M12 1C9 5 2 9 2 14C2 20 9 21 11 16C11 19 10 21 8 23H16C14 21 13 19 13 16C15 21 22 20 22 14C22 9 15 5 12 1Z',h:'M12 21C9 18 2 13 2 7.6C2 1.8 9 .8 12 6C15 .8 22 1.8 22 7.6C22 13 15 18 12 21Z',d:'M12 1 22 12 12 23 2 12Z',c:'M12 1a5 5 0 0 1 4.4 7.4a5.2 5.2 0 1 1-3.4 8.6c0 2 1 4 3 6H8c2-2 3-4 3-6A5.2 5.2 0 1 1 7.6 8.4A5 5 0 0 1 12 1Z'};
function card(code){const el=document.createElement('span');el.className='card';el.setAttribute('role','img');if(!code){el.classList.add('empty');el.setAttribute('aria-label','待发公共牌');return el;}if(code==='??'){el.classList.add('back');el.setAttribute('aria-label','未公开底牌');return el;}if('hd'.includes(code[1]))el.classList.add('red');const rank=document.createElement('span');rank.className='card-rank';rank.textContent=code[0]==='T'?'10':code[0];const suit=document.createElementNS('http://www.w3.org/2000/svg','svg');suit.classList.add('card-suit');suit.setAttribute('viewBox','0 0 24 24');suit.setAttribute('aria-hidden','true');suit.setAttribute('focusable','false');const shape=document.createElementNS('http://www.w3.org/2000/svg','path');shape.setAttribute('d',suitPaths[code[1]]);suit.append(shape);el.setAttribute('aria-label',({s:'黑桃',h:'红桃',d:'方块',c:'梅花'})[code[1]]+' '+rank.textContent);el.append(rank,suit);return el;}
function cards(codes){const el=document.createElement('div');el.className='cards';codes.forEach(c=>el.append(card(c)));return el;}
const phases={waiting:'等待入座',preflop:'翻牌前',flop:'翻牌',turn:'转牌',river:'河牌',ended:'本局结束'};
function syncTurnIndicator(){
  const game=state?.game,me=game?.players.find(p=>p.id===state.you);
  const active=!!(welcomed&&socket?.readyState===WebSocket.OPEN&&state&&!state.room.finished&&
    !['waiting','ended'].includes(game.phase)&&game.turnId===state.you&&me?.seated&&me.inHand&&!me.folded&&me.chips>0&&!roundDisplay.settling&&state.room.deadline>Date.now());
  $('own-turn-indicator').hidden=!active;
  $('own-turn-indicator').classList.toggle('urgent',active&&state.room.deadline-Date.now()<=10000);
  document.body.classList.toggle('my-turn',active);
}
function disableActions(){syncTurnIndicator();closeAllin();for(const id of ['fold','call','raise','allin','start','rebuy','leave','leave-confirm','raise-amount','finish','stand','seat','save-blinds'])$(id).disabled=true;for(const b of $('quick-bets').querySelectorAll('button'))b.disabled=true;renderBank();renderReveal();}
function allinContext(){
  if(!state||!welcomed||socket?.readyState!==WebSocket.OPEN||roundDisplay.settling)return null;
  const {room,game,you}=state,me=game.players.find(p=>p.id===you);
  if(room.finished||['waiting','ended'].includes(game.phase)||game.turnId!==you||!me?.seated||!me.inHand||me.folded||me.chips<=0||room.deadline<=Date.now())return null;
  const amount=me.bet+me.chips,action=wagerAction(game,me,amount);
  if(!action)return null;
  return {key:[room.code,you,game.hand,game.phase,room.deadline,game.currentBet,game.canRaise,me.bet,me.chips].join(':'),chips:me.chips,amount,action};
}
function closeAllin(){allinTarget=null;$('allin-confirm').disabled=true;if($('allin-dialog').open)$('allin-dialog').close();}
function syncAllin(){if(allinTarget&&allinTarget.key!==allinContext()?.key)closeAllin();}
function resetSeatVote(){
  shufflePending=null;shownSeatVote=null;previousSeatVote=null;
  if($('seat-vote-dialog').open)$('seat-vote-dialog').close();
}
function renderSeatVote(){
  if(!state)return;
  const {room,game,you}=state,vote=room.seatVote,owner=room.ownerId===you,seated=game.players.filter(p=>p.seated);
  const live=!['waiting','ended'].includes(game.phase),online=seated.every(p=>p.online);
  if(shufflePending&&((shufflePending.type==='shuffle-request'&&vote)||
    (shufflePending.type!=='shuffle-request'&&(!vote||vote.id!==shufflePending.voteId||(shufflePending.agree&&vote.approvedIds.includes(you))))))shufflePending=null;
  $('shuffle-request').hidden=!owner;
  $('shuffle-request').disabled=!welcomed||room.finished||live||seated.length<2||!online||!!vote||!!shufflePending;
  $('shuffle-request').textContent=shufflePending?.type==='shuffle-request'?'正在发起…':'发起换位投票';
  $('seat-order').textContent='当前顺序：'+seated.map(p=>p.name).join(' → ');
  $('seat-vote-open').hidden=!vote;
  $('seat-vote-open').disabled=!welcomed;
  $('seat-vote-open').textContent=vote?'查看投票 · '+vote.approvedIds.length+'/'+vote.participantIds.length+' 同意':'查看换位投票';
  $('seat-shuffle-status').textContent=!welcomed?'连接中断，请重连后操作':room.finished?'牌桌已结束':vote?'正在征求全体在座玩家同意，投票结束后才能开局':live?'本局结束后可发起换位':seated.length<2?'至少需要两位在座玩家':!online?'请等待所有在座玩家上线':owner?'发起即代表你同意；观战玩家不参与投票':'由房主发起，所有在座玩家都同意才换位';
  if(!vote){
    if(previousSeatVote&&welcomed)toast(game.events.at(-1)||'换位投票已结束');
    previousSeatVote=null;shownSeatVote=null;
    if($('seat-vote-dialog').open)$('seat-vote-dialog').close();
    return;
  }
  previousSeatVote=vote.id;
  const participant=vote.participantIds.includes(you),approved=vote.approvedIds.includes(you),waiting=!!shufflePending;
  const expired=vote.expiresAt<=Date.now(),enabled=welcomed&&!waiting&&!expired;
  $('seat-vote-progress').textContent=vote.approvedIds.length+' / '+vote.participantIds.length+' 已同意';
  $('seat-vote-remaining').textContent='剩余 '+Math.max(0,Math.ceil((vote.expiresAt-Date.now())/1000))+' 秒';
  $('seat-vote-members').replaceChildren();
  for(const id of vote.participantIds){
    const player=game.players.find(p=>p.id===id),yes=vote.approvedIds.includes(id),item=document.createElement('li');
    const name=document.createElement('b'),status=document.createElement('span');
    name.textContent=(player?.name||'玩家')+(id===you?' · 你':'');name.title=name.textContent;
    status.textContent=yes?'已同意':'待确认';item.className=yes?'agreed':'';item.append(name,status);$('seat-vote-members').append(item);
  }
  $('seat-vote-agree').hidden=!participant;$('seat-vote-agree').disabled=!enabled||approved;
  $('seat-vote-agree').textContent=approved?'已同意':waiting?'正在提交…':'同意换位';
  $('seat-vote-reject').hidden=!participant||owner;$('seat-vote-reject').disabled=!enabled;
  $('seat-vote-cancel').hidden=!owner;$('seat-vote-cancel').disabled=!enabled;
  if(!welcomed){if($('seat-vote-dialog').open)$('seat-vote-dialog').close();return;}
  if(shownSeatVote!==vote.id&&(participant||owner)&&!expired){shownSeatVote=vote.id;$('seat-vote-dialog').showModal();}
}
function respondSeatVote(type,agree){
  const vote=state?.room.seatVote;
  if(!vote||!welcomed||shufflePending||vote.expiresAt<=Date.now())return;
  if(type==='shuffle-cancel'?state.room.ownerId!==state.you:!vote.participantIds.includes(state.you))return;
  if(type==='shuffle-vote'&&agree&&vote.approvedIds.includes(state.you))return;
  shufflePending={type,voteId:vote.id,agree};renderSeatVote();send({type,voteId:vote.id,...(type==='shuffle-vote'?{agree}:{})});
}
function renderReveal(){
  $('my-hand').querySelector('.reveal-controls')?.remove();
  if(!state)return;
  const {game,room,you}=state,me=game.players.find(p=>p.id===you);
  if(revealRequest&&(revealRequest.code!==room.code||revealRequest.hand!==game.hand||me?.revealed))revealRequest=null;
  if(game.phase!=='ended'||!me?.inHand||me.cards.length!==2)return;
  const controls=document.createElement('div');controls.className='reveal-controls';
  const status=document.createElement('span');status.className='reveal-status';status.textContent=me.revealed?'大家都能看见':!welcomed?'重连后可亮牌':'仅自己可见';
  const button=document.createElement('button');button.id='reveal';button.type='button';button.className='secondary';
  button.textContent=me.revealed?'本局已亮牌':revealRequest?'正在亮牌…':'亮牌给大家';
  button.disabled=!welcomed||me.revealed||!!revealRequest||roundDisplay.settling;
  button.title='向本房所有玩家和观众公开这两张底牌，本局内不能撤回';
  button.onclick=()=>{if(!welcomed||button.disabled||state?.room.code!==room.code||state.game.hand!==game.hand||state.game.phase!=='ended')return;revealRequest={code:room.code,hand:game.hand};renderReveal();send({type:'reveal',hand:game.hand});};
  controls.append(status,button);$('my-hand').append(controls);
}
function bankAccount(){
  const entry=state?.room.summary.find(p=>p.id===state.you);
  return entry?{...entry,repaid:entry.repaid??0,debt:entry.debt??entry.borrowed}:null;
}
function chipUnit(){return state?.game.initialChips??2000;}
function repaymentMaximum(entry){const unit=chipUnit();return Math.floor(Math.min(entry?.chips??0,entry?.debt??0)/unit)*unit;}
function validRepayment(amount,max){const unit=chipUnit();return Number.isSafeInteger(amount)&&amount>=unit&&amount%unit===0&&amount<=max;}
function bankModeSelect(mode){bankMode=mode;for(const name of ['borrow','repay']){$('bank-tab-'+name).setAttribute('aria-selected',String(name===mode));$('bank-'+name+'-pane').hidden=name!==mode;}renderBank();}
function renderBank(){
  if(!state)return;
  const {room,game,you}=state,me=game.players.find(p=>p.id===you),entry=bankAccount(),unit=chipUnit(),unitText=unit.toLocaleString(),live=!['waiting','ended'].includes(game.phase);
  if(bankRequest&&bankRequest.code===room.code&&entry){
    const completed=bankRequest.kind==='borrow'?entry.borrowed>bankRequest.borrowed:entry.repaid>=bankRequest.repaid+bankRequest.amount;
    if(completed){
      const message=bankRequest.kind==='borrow'?'已借入 '+unitText+' 筹码':('已归还 '+bankRequest.amount.toLocaleString()+' 筹码');
      if(bankRequest.kind==='repay'){
        // Require a new amount after success, so a fast second click cannot repay twice.
        $('repay-amount').value='';bankDraftKey=[room.code,you,entry.chips,entry.debt].join(':');
      }
      bankRequest=null;toast(message);
    }
  }
  for(const [id,value] of [['bank-chips',entry?.chips??me?.chips??0],['bank-debt',entry?.debt??0],['bank-net',entry?.net??0],['bank-borrowed',entry?.borrowed??0],['bank-repaid',entry?.repaid??0]])$(id).textContent=value.toLocaleString();
  $('bank-net').classList.toggle('negative',(entry?.net??0)<0);
  const ready=welcomed&&!bankRequest&&!room.finished&&!live&&!!entry;
  const available=ready&&me?.seated&&me.chips===0,max=repaymentMaximum(entry),canRepay=ready&&max>=unit;
  const draftKey=[room.code,you,entry?.chips,entry?.debt].join(':');
  if(draftKey!==bankDraftKey){$('repay-amount').value=max||'';bankDraftKey=draftKey;}
  const amount=Number($('repay-amount').value);
  $('repay-amount').min=unit;$('repay-amount').step=unit;$('repay-amount').max=max;$('repay-amount').disabled=!canRepay;
  $('bank-loan-unit').textContent=unitText;$('repay-rule').textContent='本房初始筹码 '+unitText+'；还款须为 '+unitText+' 的正整数倍。';
  $('repay').disabled=!canRepay||!validRepayment(amount,max);
  $('repay-all').disabled=!canRepay;
  $('repay-limit').textContent='最多可还 '+max.toLocaleString();
  $('repay-all').textContent=max>0&&max===(entry?.debt??0)?'全部还清':'归还最多';
  $('repay').textContent=bankRequest?.kind==='repay'?'正在归还…':'确认归还';
  $('rebuy').disabled=!available;$('rebuy').textContent=bankRequest?.kind==='borrow'?'正在借入…':'借入 '+unitText+' 筹码';
  $('bank').classList.toggle('bank-ready',!!available);
  $('bank').title=available?'筹码为 0，可借入 '+unitText+' 筹码':'查看筹码余额、借还记录和未还欠款';
  let message=!welcomed?'连接中断，重连后可办理':room.finished?'牌桌已结束，最终账目已固定':bankRequest?'正在处理，请稍候…':live?'请等本局结算后再借还筹码':'';
  if(!message&&bankMode==='repay')message=!entry?'入座产生借款后，才需要归还':!entry.debt?'没有未还欠款':entry.debt<unit?'未还欠款不足 '+unitText+'，暂不能归还；结算仍会扣除欠款':entry.chips<unit?'现有筹码不足 '+unitText+'，暂不能归还':!$('repay-amount').value?'输入 '+unitText+' 的整数倍，也可点击快捷归还':!validRepayment(amount,max)?'请输入 '+unitText+' 的正整数倍，最多 '+max.toLocaleString():'归还会同时减少筹码与欠款，净筹码不变';
  if(!message)message=!me?.seated?'观战中，请重新入座后再借筹码':me.chips>0?'筹码尚未用完，暂时不能借入':'筹码已用完，可以借入继续玩';
  $('bank-status').textContent=message;$('bank-status').classList.toggle('bank-available',bankMode==='borrow'?!!available:canRepay);
}
function repayChips(amount){
  renderBank();const entry=bankAccount();
  if(!state||!entry||!welcomed||bankRequest||state.room.finished||!['waiting','ended'].includes(state.game.phase)||!validRepayment(amount,repaymentMaximum(entry)))return;
  const requestId=globalThis.crypto?.randomUUID?.()||Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);
  bankRequest={kind:'repay',code:state.room.code,repaid:entry.repaid,amount,requestId};renderBank();send({type:'repay',amount,requestId});
}
function render(){
  const {game:g,room:r,you}=state,me=g.players.find(p=>p.id===you),live=!['waiting','ended'].includes(g.phase),myTurn=g.turnId===you;
  const roundVisual=roundDisplay.update(state),canAct=myTurn&&welcomed&&!roundVisual.settling;
  clearTimeout(roundDisplayTimer);if(roundVisual.remaining)roundDisplayTimer=setTimeout(()=>{if(state)render();},roundVisual.remaining+16);
  document.body.classList.add('in-room');document.body.classList.toggle('live-hand',live);$('lobby').hidden=true;$('room').hidden=false;$('code').textContent=r.code;$('phase').textContent=`${phases[g.phase]}${g.hand?' · 第 '+g.hand+' 局':''}`;$('blinds').textContent=`盲注 ${g.smallBlind}/${g.bigBlind}`;$('pot').textContent=g.pot;
  syncTurnIndicator();$('seat-count').textContent=g.players.filter(p=>p.seated).length+' / 9 人';
  $('privacy').textContent=r.locked?'密码保护':'公开房间';$('settings').hidden=r.ownerId!==you;$('create-password').value='';$('create-authorization').value='';$('join-password').value='';
  const resultPlayers=new Set(g.phase==='ended'&&g.handResults?.hand===g.hand?g.handResults.players.map(p=>p.id):[]);
  const positions=new Map(seatPositions(g.players.map(p=>({...p,seated:p.seated||resultPlayers.has(p.id)})),you).map(p=>[p.id,p]));
  const betContext=[r.code,g.hand,g.phase].join(':');
  $('bet-markers').replaceChildren();
  $('self-seat').replaceChildren();
  $('seats').replaceChildren();g.players.forEach((p,i)=>{if(!p.seated&&!resultPlayers.has(p.id)&&p.id!==you)return;const el=document.createElement('div');el.className=`seat${p.id===g.turnId?' active':''}${p.folded?' folded':''}${p.id===you?' me':''}`;
    const position=positions.get(p.id)||{x:50,y:88};el.dataset.playerId=p.id;el.style.setProperty('--seat-x',position.x+'%');el.style.setProperty('--seat-y',position.y+'%');el.style.left=p.id===you?'auto':position.x+'%';el.style.top=p.id===you?'auto':position.y+'%';
    el.classList.add(position.y<24?'seat-top':position.x<50?'seat-left':'seat-right');el.classList.toggle('seat-top-left',position.y<24&&position.x<50);el.classList.toggle('offline',!p.online);el.style.setProperty('--avatar-hue',String((i*47+135)%360));
    const shownBet=roundVisual.markers.get(p.id);
    if(shownBet){
      const marker=document.createElement('div');marker.className='bet-marker';marker.dataset.playerId=p.id;marker.classList.add(position.x<50?'chip-left':'chip-right');if(position.y<24)marker.classList.add('chip-below');else if(position.y>72)marker.classList.add('chip-above');marker.style.setProperty('--seat-x',position.x+'%');marker.style.setProperty('--seat-y',position.y+'%');
      const amountText=shownBet.result?(shownBet.amount>0?'+':shownBet.amount<0?'−':'')+Math.abs(shownBet.amount).toLocaleString():shownBet.amount.toLocaleString();
      marker.setAttribute('aria-label',p.name+(shownBet.result?' 本局净赢输 ':shownBet.settling?' 上轮已下注 ':' 本轮已下注 ')+amountText);
      if(shownBet.result){marker.classList.add('hand-result',shownBet.amount>0?'result-win':shownBet.amount<0?'result-loss':'result-even');marker.title='本局净赢输（包含盲注和下注）';}
      const chip=document.createElement('span');chip.className='table-chip';chip.textContent='♠';chip.setAttribute('aria-hidden','true');const amount=document.createElement('b');amount.textContent=amountText;marker.append(chip,amount);
      const before=previousBets?.context===betContext?previousBets.bets.get(p.id):undefined;
      if(shownBet.settling){marker.classList.add('settling');marker.style.animationDelay=(980-roundVisual.elapsed)+'ms';}
      else if(!shownBet.result&&before!==undefined&&p.bet>before){marker.classList.add('chip-thrown');marker.style.setProperty('--chip-dx',(position.x-50)*.5+'px');marker.style.setProperty('--chip-dy',(position.y-50)*.5+'px');}
      $('bet-markers').append(marker);
    }
    const n=document.createElement('div');n.className='seat-name';n.textContent=p.name+(p.id===you?' · 你':'');n.title=p.name+(!p.online?' · 离线':'');
    const stack=document.createElement('div');stack.className='seat-stack';const stackValue=document.createElement('span');stackValue.textContent=p.chips.toLocaleString();const stackUnit=document.createElement('span');stackUnit.className='stack-unit';stackUnit.textContent=' 筹码';stack.append(stackValue,stackUnit);
    el.classList.toggle('showing-cards',!live&&p.cards.length>0&&p.cards.every(c=>c!=='??'));
    el.classList.toggle('revealed',g.phase==='ended'&&!!p.revealed);
    const bet=document.createElement('div');bet.className='seat-bet';bet.textContent=!p.seated?'正在观战':p.folded?(p.revealed?'弃牌 · 已亮牌':'已弃牌'):p.handName||(g.phase==='ended'&&p.inHand?(p.revealed?'已亮牌':'未亮牌'):(!p.inHand&&live)?'下一局入座':p.inHand&&p.chips===0&&live?'All-in':`本轮 ${p.bet}`);
    if(!p.online)bet.textContent='离线 · '+bet.textContent;
    else if(p.id===g.turnId)bet.textContent=p.id===you?'轮到你行动':'正在思考';
    else if(live&&g.lastAction?.hand===g.hand&&g.lastAction.phase===g.phase&&g.lastAction.playerId===p.id)bet.textContent=({bet:'下注到',call:'跟注到',raise:'加注到',check:'过牌',fold:'弃牌',allin:'All-in'})[g.lastAction.kind]+(['bet','call','raise','allin'].includes(g.lastAction.kind)?' '+g.lastAction.bet:'');
    const avatar=document.createElement('div');avatar.className='avatar';avatar.textContent=p.name.slice(0,1);el.append(avatar,n,stack,bet);if(i===g.button){const dealer=document.createElement('span');dealer.className='dealer-button';dealer.textContent='D';dealer.title='庄位';el.append(dealer);}if(p.id!==you&&p.cards.length)el.append(cards(p.cards));$(p.id===you?'self-seat':'seats').append(el);
  });
  const ownMarker=[...$('bet-markers').children].find(el=>el.dataset.playerId===you);
  previousBets={context:betContext,bets:new Map(g.players.map(p=>[p.id,p.bet]))};
  $('board').replaceChildren(...Array.from({length:5},(_,i)=>{const el=card(g.board[i]);if(roundVisual.settling&&g.board[i]&&i>=roundVisual.firstNewCard){el.classList.add('revealing');el.style.animationDelay=((i-roundVisual.firstNewCard)*130-roundVisual.elapsed)+'ms';}return el;}));
  $('my-hand').hidden=!me.seated&&!resultPlayers.has(you);$('actions').hidden=!me.seated;$('hole-cards').replaceChildren(...me.cards.map(card));$('my-hand').querySelector('.own-bet')?.remove();
  if(ownMarker){ownMarker.classList.add('own-bet');ownMarker.style.removeProperty('left');ownMarker.style.removeProperty('top');$('my-hand').append(ownMarker);}
  renderReveal();
  $('fold').disabled=!canAct;$('call').disabled=!canAct;$('call').textContent=g.toCall?`跟注到 ${Math.min(g.currentBet,me.bet+me.chips)}`:'过牌';$('call').title=`本轮已下 ${me.bet}，本次补 ${Math.min(g.toCall,me.chips)}`;
  const bounds=wagerBounds(g,me),key=[r.code,g.hand,g.phase,g.turnId,g.currentBet,g.minRaise,me.bet,me.chips].join(':');
  $('raise-amount').min=bounds.min;$('raise-amount').max=bounds.max;if(key!==raiseKey){$('raise-amount').value=bounds.initial;raiseKey=key;}
  $('raise-amount').disabled=!canAct||!bounds.allowed;
  $('raise').disabled=!canAct||!bounds.allowed;for(const b of $('quick-bets').querySelectorAll('button'))b.disabled=$('raise').disabled;updateWagerLabel();
  const maximum=me.bet+me.chips;
  $('allin').disabled=!canAct||(maximum>g.currentBet&&!g.canRaise);
  syncAllin();
  $('start').hidden=live||r.finished||(!r.seatVote&&r.ownerId!==you);$('start').disabled=r.seatVote?!welcomed:roundVisual.settling||g.players.filter(p=>p.seated&&p.chips>0).length<2||!welcomed;$('start').textContent=r.seatVote?'换位投票 · '+r.seatVote.approvedIds.length+'/'+r.seatVote.participantIds.length:g.hand?'开始下一局':'开始第一局';
  renderBank();$('leave').disabled=!welcomed;$('leave-confirm').disabled=!welcomed;
  $('stand').hidden=r.finished||!me.seated;$('stand').disabled=!welcomed||me.pendingStand;$('stand').textContent=live&&me.inHand&&!me.folded?'本局结束后观战':'离座观战';$('seat').hidden=r.finished||me.seated;$('seat').disabled=!welcomed||(live&&(me.inHand||me.total>0));
  const watchers=g.players.filter(p=>!p.seated);$('watchers').hidden=!watchers.length;$('watchers').textContent=`观战 ${watchers.length} 人：${watchers.map(p=>p.name).join('、')}${!me.seated?' · 你正在观战，筹码与借款记录保留':''}`;
  $('finish').hidden=live||r.finished||r.ownerId!==you;$('finish').disabled=!welcomed;
  $('summary-panel').hidden=false;$('game-layout').hidden=r.finished;$('summary-title').textContent=r.finished?'牌桌已结束 · 最终总计':'本桌筹码总计';$('summary-hands').textContent=`共 ${g.hand} 局`;$('summary-initial-chips').textContent=chipUnit().toLocaleString();$('summary-note').textContent=r.finished?'总计已固定。可下载保存记录，或离开后创建新房间。':'包含提前离开的玩家。借款累计记录，同一身份重新入座不会重置。';renderSummary(r.summary);
  $('hint').textContent=me.pendingStand?'已预约离座，请完成当前手牌，结算后自动观战':!me.seated?'你正在观战，重新入座后参与下一局':live?'输入本轮下注目标，确认时只补差额':r.ownerId!==you?'等待房主开局':g.players.length<2?'把房间号发给朋友，至少 2 人开局':'';
  $('events').replaceChildren();for(const message of [...g.events].reverse()){const p=document.createElement('p');p.textContent=message;$('events').append(p);}if(!g.events.length){const p=document.createElement('p');p.textContent='朋友入座后，由房主开始第一局。';$('events').append(p);}const nextBlindKey=[r.code,g.smallBlind,g.bigBlind].join(':');if(nextBlindKey!==blindKey){$('room-small').value=g.smallBlind;$('room-big').value=g.bigBlind;blindKey=nextBlindKey;}for(const id of ['room-small','room-big','save-blinds'])$(id).disabled=live||r.finished||r.ownerId!==you||!welcomed;renderMembers();renderSeatVote();updateClock();tableReactions.update(state);
}
function renderMembers(){
  const {game,room,you}=state;$('player-management').hidden=room.ownerId!==you;$('member-list').replaceChildren();
  for(const p of game.players){
    const row=document.createElement('div');row.className='member-row';const info=document.createElement('div'),title=document.createElement('b'),status=document.createElement('small');
    title.textContent=p.name+(p.id===you?' · 房主':'');status.textContent=`${p.online?'在线':'离线'} · ${p.seated?'入座':'观战'} · ${p.chips.toLocaleString()} 筹码`;info.append(title,status);row.append(info);
    if(p.id!==you){const button=document.createElement('button');button.className='quiet small';button.textContent='移出';button.setAttribute('aria-label','移出 '+p.name);button.disabled=!welcomed;button.onclick=()=>{kickTarget={id:p.id,code:room.code};$('kick-message').textContent=`确定移出 ${p.name}？参与本局时会弃牌，已 All-in 的筹码仍正常结算。筹码与借款记录保留在总计中。`;$('kick-dialog').showModal();};row.append(button);}
    $('member-list').append(row);
  }
}
$('kick-cancel').onclick=()=>{$('kick-dialog').close();kickTarget=null;};
$('kick-confirm').onclick=()=>{const target=kickTarget;$('kick-dialog').close();kickTarget=null;if(!state||!target||target.code!==state.room.code||state.room.ownerId!==state.you)return;send({type:'kick',playerId:target.id});};
function renderSummary(rows){
  $('summary-rows').replaceChildren();
  for(const row of rows){const entry={...row,repaid:row.repaid??0,debt:row.debt??row.borrowed};const tr=document.createElement('tr');for(const field of ['name','chips','borrowed','repaid','debt','net']){const td=document.createElement('td');td.textContent=field==='name'?entry.name+(entry.id===state.you?' · 你':''):entry[field].toLocaleString();if(field==='net')td.className=entry.net<0?'negative':'positive';tr.append(td);}$('summary-rows').append(tr);}
  const total=rows.reduce((sum,p)=>({chips:sum.chips+p.chips,borrowed:sum.borrowed+p.borrowed,repaid:sum.repaid+(p.repaid??0),debt:sum.debt+(p.debt??p.borrowed),net:sum.net+p.net}),{chips:0,borrowed:0,repaid:0,debt:0,net:0});
  const tr=document.createElement('tr');for(const value of ['合计',total.chips,total.borrowed,total.repaid,total.debt,total.net]){const td=document.createElement('td');td.textContent=typeof value==='number'?value.toLocaleString():value;tr.append(td);}$('summary-total').replaceChildren(tr);
}
$('finish').onclick=()=>$('finish-dialog').showModal();
$('finish-cancel').onclick=()=>$('finish-dialog').close();
$('finish-confirm').onclick=()=>{$('finish-dialog').close();send({type:'finish'});};
$('download-summary').onclick=()=>{
  const r=state.room,rows=r.summary,text=['好友牌局 · 房间 '+r.code,r.finished?'最终总计':'当前总计','已玩 '+state.game.hand+' 局','净筹码 = 剩余筹码 − 未还欠款；未还欠款 = 累计借入 − 累计归还；初始筹码每人 '+chipUnit().toLocaleString(),'',...rows.map(p=>p.name+'：剩余 '+p.chips+'，累计借入 '+p.borrowed+'，累计归还 '+(p.repaid??0)+'，未还欠款 '+(p.debt??p.borrowed)+'，净筹码 '+p.net)].join('\n');
  const url=URL.createObjectURL(new Blob([text],{type:'text/plain;charset=utf-8'})),link=document.createElement('a');link.href=url;link.download='牌桌总计-'+r.code+'.txt';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
};
function updateClock(){syncTurnIndicator();if(!state)return;syncAllin();if(state.room.seatVote)renderSeatVote();gameSounds.tick(state);const actor=state.game.players.find(p=>p.id===state.game.turnId),seconds=Math.max(0,Math.ceil((state.room.deadline-Date.now())/1000));$('turn').textContent=roundDisplay.settling?(state.game.phase==='ended'?'本轮下注结算中…':'正在发牌…'):actor?`${actor.id===state.you?'轮到你':actor.name+' 思考中'} · ${seconds} 秒`:state.game.phase==='ended'?'筹码已结算，等待下一局':'分享房间号，邀请朋友入座';$('turn-mini').textContent=$('turn').textContent;$('turn-mini').classList.toggle('urgent',!!actor&&seconds<=10);for(const el of document.querySelectorAll('.seat.active')){el.style.setProperty('--turn-progress',Math.min(1,seconds/45));el.classList.toggle('urgent',seconds<=10);}}
setInterval(updateClock,1000);
$('fold').onclick=()=>send({type:'action',action:'fold'});$('call').onclick=()=>send({type:'action',action:state.game.toCall?'call':'check'});$('raise').onclick=()=>{const me=state.game.players.find(p=>p.id===state.you),bounds=wagerBounds(state.game,me),amount=Number($('raise-amount').value),action=wagerAction(state.game,me,amount);if(!action){toast(`本轮已下 ${me.bet}，跟注到 ${bounds.min}，加注至少到 ${bounds.raiseMin}，最多到 ${bounds.max}`);return;}send(action);};
function updateWagerLabel(){if(!state)return;const me=state.game.players.find(p=>p.id===state.you),amount=Number($('raise-amount').value),bounds=wagerBounds(state.game,me),action=wagerAction(state.game,me,amount),paid=Math.max(0,amount-me.bet);$('raise').disabled=!welcomed||roundDisplay.settling||state.game.turnId!==state.you||!action;$('raise').textContent=action?.action==='check'?'确认过牌':action?.action==='call'?`跟注 · 补 ${paid}`:action?`下注 · 补 ${paid}`:`最低到 ${bounds.raiseMin}`;$('raise-amount').title=`本轮目标 ${amount}，已下 ${me.bet}${action?'，确认补 '+paid:''}`;}
$('raise-amount').oninput=updateWagerLabel;
for(const button of $('quick-bets').querySelectorAll('button'))button.onclick=()=>{if(!state||button.disabled)return;const me=state.game.players.find(p=>p.id===state.you);$('raise-amount').value=adjustWager($('raise-amount').value,Number(button.dataset.delta),wagerBounds(state.game,me));updateWagerLabel();};
$('save-blinds').onclick=()=>send({type:'blinds',smallBlind:Number($('room-small').value),bigBlind:Number($('room-big').value)});
$('allin').onclick=()=>{
  const target=allinContext();if(!target||$('allin').disabled)return;
  allinTarget=target;$('allin-amount').textContent=target.chips.toLocaleString();
  $('allin-total').textContent='本轮下注合计 '+target.amount.toLocaleString()+' 筹码';
  $('allin-confirm').disabled=false;$('allin-dialog').showModal();
};
$('allin-cancel').onclick=closeAllin;
$('allin-dialog').oncancel=()=>{allinTarget=null;$('allin-confirm').disabled=true;};
$('allin-confirm').onclick=()=>{
  const target=allinTarget,current=allinContext();closeAllin();
  if(!target||target.key!==current?.key){toast('回合已变化，请重新选择操作');return;}
  send(current.action);
};
$('stand').onclick=()=>send({type:'stand'});$('seat').onclick=()=>send({type:'seat'});
$('start').onclick=()=>{if(state?.room.seatVote){renderSeatVote();if(welcomed&&!$('seat-vote-dialog').open)$('seat-vote-dialog').showModal();}else send({type:'start'});};
$('shuffle-request').onclick=()=>{renderSeatVote();if($('shuffle-request').disabled)return;shufflePending={type:'shuffle-request'};renderSeatVote();send({type:'shuffle-request'});};
$('seat-vote-open').onclick=()=>{renderSeatVote();if(state?.room.seatVote&&welcomed&&!$('seat-vote-dialog').open)$('seat-vote-dialog').showModal();};
$('seat-vote-close').onclick=()=>$('seat-vote-dialog').close();
$('seat-vote-agree').onclick=()=>respondSeatVote('shuffle-vote',true);
$('seat-vote-reject').onclick=()=>respondSeatVote('shuffle-vote',false);
$('seat-vote-cancel').onclick=()=>respondSeatVote('shuffle-cancel');
$('bank').onclick=()=>{if(!state)return;const entry=bankAccount();bankDraftKey='';bankModeSelect(entry?.debt>0&&entry?.chips>0?'repay':'borrow');$('bank-dialog').showModal();};
$('bank-close').onclick=()=>$('bank-dialog').close();
for(const mode of ['borrow','repay'])$('bank-tab-'+mode).onclick=()=>bankModeSelect(mode);
$('repay-amount').oninput=renderBank;
$('repay').onclick=()=>repayChips(Number($('repay-amount').value));
$('repay-all').onclick=()=>{const entry=bankAccount();if(entry)repayChips(repaymentMaximum(entry));};
$('rebuy').onclick=()=>{renderBank();if($('rebuy').disabled)return;bankRequest={kind:'borrow',code:state.room.code,borrowed:state.room.summary.find(p=>p.id===state.you).borrowed};renderBank();send({type:'rebuy'});};
$('leave').onclick=()=>{if(!state||!welcomed)return;leaveTarget=state.room.code;$('leave-dialog').showModal();};
$('leave-cancel').onclick=()=>{$('leave-dialog').close();leaveTarget=null;};
$('leave-confirm').onclick=()=>{const code=leaveTarget;$('leave-dialog').close();leaveTarget=null;if(state?.room.code===code&&welcomed)send({type:'leave'});};
function invitation(){const url=new URL(location.pathname,location.origin);url.searchParams.set('room',state.room.code);return {url:url.href,title:'好友牌局',text:`一起玩扑克，房间号：${state.room.code}`};}
$('copy').onclick=async()=>{const invite=invitation();try{await navigator.clipboard.writeText(`${invite.text}\n${invite.url}`);toast('邀请链接已复制，发给朋友即可');}catch{window.prompt('复制此链接发给朋友',invite.url);}};
$('share').onclick=async()=>{const invite=invitation();if(!navigator.share){$('copy').click();return;}try{await navigator.share(invite);}catch(error){if(error.name!=='AbortError')$('copy').click();}};
$('roomcode').addEventListener('keydown',event=>{if(event.key==='Enter')enter('join');});
$('join-password').addEventListener('keydown',event=>{if(event.key==='Enter')enter('join');});
$('settings').onclick=()=>{$('settings-locked').checked=state.room.locked;$('settings-password').value='';$('settings-password').disabled=!state.room.locked;$('room-settings').showModal();};
$('settings-locked').onchange=()=>{$('settings-password').disabled=!$('settings-locked').checked;};
$('settings-save').onclick=()=>{const password=$('settings-locked').checked?$('settings-password').value:'';if($('settings-locked').checked&&(password.length<4||password.length>32)){toast('请输入 4～32 个字符的新密码');return;}send({type:'password',password});};
$('settings-cancel').onclick=()=>$('room-settings').close();
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&!manualStop&&playerMemory.read().token&&(!socket||socket.readyState===WebSocket.CLOSED))connect();});
if(storedPlayer.token)connect();
