const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

function fixture(){
  let now=1000,connected=true,nextTimer=0,reduced=false,rotated=false;
  let state={you:'a',room:{code:'123456'},game:{players:[{id:'a',name:'甲',online:true,seated:true},{id:'b',name:'乙',online:true,seated:true},{id:'w',name:'观众',online:true,seated:false},{id:'off',name:'离线',online:false,seated:true}]}};
  const timers=new Map(),sent=[],notices=[],animations=[],page={hidden:false};
  const document={hidden:false,body:{classList:{contains:()=>rotated}},getElementById:id=>id==='page-table'?page:null,querySelectorAll:()=>[],querySelector:()=>null};
  class Clock extends Date{static now(){return now;}}
  const setTimer=callback=>{const id=++nextTimer;timers.set(id,callback);return id;};
  const context={module:{exports:{}},document,Date:Clock,window:{innerWidth:568,innerHeight:320,matchMedia:()=>({matches:reduced})},setTimeout:setTimer,setInterval:setTimer,clearTimeout:id=>timers.delete(id),clearInterval:id=>timers.delete(id)};
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'../web/reactions.js'),'utf8'),context);
  const {TableReactions,TABLE_REACTIONS,reactionRecipients,reactionPoint}=context.module.exports;
  const element=(tag,className,text)=>({tag,className,textContent:text,children:[],style:{},removed:false,classList:{add(){}},append(...nodes){this.children.push(...nodes);},remove(){this.removed=true;},animate(frames,options){const animation={frames,options,cancelled:false,cancel(){this.cancelled=true;}};animations.push(animation);return animation;}});
  const instance=Object.assign(Object.create(TableReactions.prototype),{
    getState:()=>state,isConnected:()=>connected,send:message=>sent.push(JSON.parse(JSON.stringify(message))),notice:message=>notices.push(message),
    state,selectedEmoji:'laugh',selectedTarget:'b',cooldownUntil:0,pending:false,seen:new Map(),items:[],targetSignature:'',seatSignature:'',
    openButton:{disabled:false},target:{},emojiButtons:[],sendButton:{},status:{},dialog:{open:true,close(){this.open=false;}},live:{textContent:''},element,layer:element('div'),
    anchor:id=>({left:id==='a'?400:150,top:160,width:80,height:40})
  });
  return {instance,TABLE_REACTIONS,reactionRecipients,reactionPoint,sent,notices,timers,animations,document,page,advance:amount=>{now+=amount;},setConnected:value=>{connected=value;},setState:value=>{state=value;instance.state=value;},get state(){return state;},setReduced:value=>{reduced=value;},setRotated:value=>{rotated=value;}};
}
const event=(id='event-1',fields={})=>({type:'reaction',id,room:'123456',from:'a',to:'b',emoji:'laugh',fromName:'甲',toName:'乙',...fields});

test('表情目标包含同房在线观众，排除自己和离线玩家，预设ID唯一',()=>{
  const f=fixture();assert.deepEqual(f.reactionRecipients(f.state).map(player=>player.id),['b','w']);
  assert.equal(f.TABLE_REACTIONS.length,8);assert.equal(new Set(f.TABLE_REACTIONS.map(item=>item.id)).size,8);
  f.state.you='w';assert.deepEqual(f.reactionRecipients(f.state).map(player=>player.id),['a','b']);
});

test('发送需要明确目标，防重复点击，确认回包才播放并保持两秒冷却',()=>{
  const f=fixture(),r=f.instance;r.submit();
  assert.deepEqual(f.sent,[{type:'reaction',emoji:'laugh',to:'b'}]);assert.equal(r.pending,true);assert.equal(r.dialog.open,false);assert.equal(r.items.length,0);
  r.submit();assert.equal(f.sent.length,1);
  r.receive(event());assert.equal(r.pending,false);assert.equal(r.items.length,1);assert.equal(r.sendButton.disabled,true);
  f.advance(1999);r.submit();assert.equal(f.sent.length,1);
  f.advance(2);r.renderControls();assert.equal(r.sendButton.disabled,false);r.submit();assert.equal(f.sent.length,2);
  r.reset();assert.equal(f.timers.size,0);assert.equal(r.items.length,0);
});

test('断线和失效目标不能发送，服务端错误恢复控件并遵循重试间隔',()=>{
  const f=fixture(),r=f.instance;f.setConnected(false);r.submit();assert.equal(f.sent.length,0);f.setConnected(true);
  r.selectedTarget='off';r.update=state=>{r.state=state;};r.submit();assert.equal(f.sent.length,0);assert.match(f.notices.at(-1),/离开或断线/);
  r.selectedTarget='w';r.submit();assert.equal(f.sent[0].to,'w');r.error({message:'稍后再试',retryAfterMs:900});assert.equal(r.pending,false);assert.equal(r.sendButton.disabled,true);assert.equal(f.notices.at(-1),'稍后再试');
  f.advance(901);r.renderControls();assert.equal(r.sendButton.disabled,false);
  r.reset();assert.equal(r.openButton.disabled,true);assert.equal(r.dialog.open,false);assert.equal(f.timers.size,0);
});

test('错误房间、非法表情和重复事件不播放，后台和其他面板不积压动画',()=>{
  const f=fixture(),r=f.instance;
  for(const fields of [{room:'654321'},{emoji:'injected'},{from:'missing'},{to:'a'}])r.receive(event('invalid',fields));
  assert.equal(r.items.length,0);r.receive(event('valid',{from:'b',to:'a'}));r.receive(event('valid',{from:'b',to:'a'}));assert.equal(r.items.length,1);
  f.page.hidden=true;r.receive(event('other-page',{from:'b',to:'a'}));assert.equal(r.items.length,1);assert.match(f.notices.at(-1),/乙|甲/);
  f.document.hidden=true;f.page.hidden=false;r.receive(event('background',{from:'b',to:'a'}));f.document.hidden=false;r.receive(event('background',{from:'b',to:'a'}));assert.equal(r.items.length,1);
  f.setConnected(false);r.receive(event('disconnected'));assert.equal(r.items.length,1);r.reset();
});

test('面板打开时接收者掉线，必须重新选择，不能自动改发给其他人',()=>{
  const f=fixture(),r=f.instance;r.target={replaceChildren(){},append(){}};
  f.state.game.players.find(player=>player.id==='b').online=false;
  r.update(f.state);assert.equal(r.selectedTarget,'');assert.equal(r.sendButton.disabled,true);
  r.update(f.state);assert.equal(r.selectedTarget,'');r.submit();assert.equal(f.sent.length,0);
  r.selectedTarget='w';r.renderControls();r.submit();assert.equal(f.sent[0].to,'w');r.reset();
});

test('最多四个动画、布局变化清理，昵称作为纯文本，减少动画模式静态显示',()=>{
  const f=fixture(),r=f.instance;
  r.receive(event('unsafe',{fromName:'<img src=x onerror=alert(1)>',toName:'<script>x</script>'}));
  const first=r.items[0];assert.equal(first.node.children[0].children[1].textContent,'<img src=x onerror=alert(1)> → <script>x</script>');
  for(let n=0;n<5;n++)r.receive(event('burst-'+n));assert.equal(r.items.length,4);assert.equal(first.node.removed,true);assert.equal(f.animations[0].cancelled,true);
  r.onLayout();assert.equal(r.items.length,0);
  f.setReduced(true);f.setRotated(true);const count=f.animations.length;r.receive(event('reduced'));assert.equal(f.animations.length,count);assert.equal(r.items[0].node.children[0].className,'reaction-pop is-rotated');r.reset();assert.equal(f.timers.size,0);
});

test('飞行动画使用物理坐标且留出屏幕边距，不把旋转后的坐标再次旋转',()=>{
  const {reactionPoint}=fixture();
  const normal=reactionPoint({left:270,top:170,width:60,height:60},800,400);assert.equal(normal.x,300);assert.equal(normal.y,200);
  const rotated=reactionPoint({left:10,top:300,width:40,height:60},375,667,true);assert.equal(rotated.x,44);assert.equal(rotated.y,330);
  const corner=reactionPoint({left:900,top:800,width:30,height:30},568,320);assert.equal(corner.x,474);assert.equal(corner.y,276);
});
