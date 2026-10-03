const TABLE_REACTIONS=Object.freeze([
  {id:'laugh',emoji:'😂',label:'大笑'},{id:'like',emoji:'👍',label:'点赞'},
  {id:'clap',emoji:'👏',label:'鼓掌'},{id:'handshake',emoji:'🤝',label:'握手'},
  {id:'cool',emoji:'😎',label:'酷'},{id:'think',emoji:'🤔',label:'思考'},
  {id:'cry',emoji:'😭',label:'哭哭'},{id:'party',emoji:'🎉',label:'庆祝'}
]);

function reactionRecipients(state){
  return (state?.game?.players||[]).filter(player=>player.id!==state.you&&player.online&&!player.pendingRemove);
}

function reactionPoint(rect,width,height,rotated=false){
  // Bounding rectangles already include the table's CSS rotation. The overlay
  // lives directly in body, so both coordinates use the physical viewport.
  const marginX=rotated?44:94,marginY=rotated?94:44;
  const clamp=(value,size,margin)=>Math.max(Math.min(margin,size/2),Math.min(size-Math.min(margin,size/2),value));
  return {x:clamp(rect.left+rect.width/2,width,marginX),y:clamp(rect.top+rect.height/2,height,marginY)};
}

class TableReactions {
  constructor({getState,isConnected,send,notice}){
    this.getState=getState;this.isConnected=isConnected;this.send=send;this.notice=notice;
    this.state=null;this.selectedEmoji='laugh';this.selectedTarget='';this.cooldownUntil=0;this.pending=false;
    this.seen=new Map();this.items=[];this.targetSignature='';this.seatSignature='';
    const element=(tag,className,text)=>{const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;};
    this.element=element;
    this.openButton=element('button','secondary small','😊 表情');this.openButton.id='reaction-open';this.openButton.type='button';
    this.openButton.setAttribute('aria-haspopup','dialog');this.openButton.setAttribute('aria-controls','reaction-dialog');this.openButton.title='给房间里的朋友发表情';
    const tools=document.querySelector('.room-top .room-tools');tools.insertBefore(this.openButton,document.getElementById('bank'));
    this.dialog=element('dialog','settings-dialog reaction-dialog');this.dialog.id='reaction-dialog';
    this.dialog.setAttribute('aria-labelledby','reaction-title');this.dialog.setAttribute('aria-describedby','reaction-description');
    const heading=element('div','reaction-heading'),title=element('h2','','发表情');title.id='reaction-title';
    const close=element('button','quiet small','关闭');close.type='button';close.setAttribute('aria-label','关闭表情面板');heading.append(title,close);
    const content=element('div','reaction-content'),recipientPanel=element('div','reaction-recipient');
    const label=element('label','','发送给');label.htmlFor='reaction-target';
    this.target=element('select','reaction-select');this.target.id='reaction-target';
    const description=element('p','','也可以点牌桌上的玩家，选好表情后点击发送。');description.id='reaction-description';
    recipientPanel.append(label,this.target,description);
    this.choices=element('div','reaction-choices');this.choices.setAttribute('role','group');this.choices.setAttribute('aria-label','选择表情');
    this.emojiButtons=TABLE_REACTIONS.map(reaction=>{
      const button=element('button','reaction-choice');button.type='button';button.dataset.reaction= reaction.id;button.setAttribute('aria-label',reaction.label);
      const icon=element('span','reaction-choice-icon',reaction.emoji);icon.setAttribute('aria-hidden','true');
      button.append(icon,element('span','reaction-choice-name',reaction.label));button.onclick=()=>{this.selectedEmoji=reaction.id;this.renderControls();};this.choices.append(button);return button;
    });
    content.append(recipientPanel,this.choices);
    const footer=element('div','reaction-footer');this.status=element('span','reaction-status');this.status.setAttribute('role','status');
    this.sendButton=element('button','primary','发送');this.sendButton.type='button';this.sendButton.id='reaction-send';footer.append(this.status,this.sendButton);
    this.dialog.append(heading,content,footer);document.body.append(this.dialog);
    this.layer=element('div','reaction-layer');this.layer.setAttribute('aria-hidden','true');document.body.append(this.layer);
    this.live=element('div','reaction-announcement');this.live.setAttribute('role','status');this.live.setAttribute('aria-live','polite');this.live.setAttribute('aria-atomic','true');document.body.append(this.live);
    this.openButton.onclick=()=>this.open();close.onclick=()=>this.dialog.close();this.sendButton.onclick=()=>this.submit();
    this.target.onchange=()=>{this.selectedTarget=this.target.value;this.renderControls();};
    document.addEventListener('click',event=>{
      if(event.target.closest?.('button,input,select,a'))return;
      const seat=event.target.closest?.('.seat[data-player-id]');if(seat?.classList.contains('reaction-target-seat'))this.open(seat.dataset.playerId);
    });
    document.addEventListener('keydown',event=>{
      const seat=event.target.closest?.('.seat[data-player-id]');
      if(seat===event.target&&seat?.classList.contains('reaction-target-seat')&&['Enter',' '].includes(event.key)){event.preventDefault();this.open(seat.dataset.playerId);}
    });
    window.addEventListener('resize',()=>this.onLayout());window.visualViewport?.addEventListener('resize',()=>this.onLayout());
    document.addEventListener('visibilitychange',()=>{if(document.hidden)this.clearAnimations();});
    this.update(null);
  }
  update(state){
    if(this.state?.room?.code!==state?.room?.code)this.reset();
    this.state=state;
    const recipients=reactionRecipients(state),signature=JSON.stringify(recipients.map(player=>[player.id,player.name,player.seated]));
    if(!recipients.some(player=>player.id===this.selectedTarget))this.selectedTarget=this.dialog.open?'':recipients[0]?.id||'';
    if(signature!==this.targetSignature){
      this.targetSignature=signature;this.target.replaceChildren();
      const placeholder=this.element('option','',recipients.length?'请选择接收玩家':'暂无其他在线玩家');placeholder.value='';this.target.append(placeholder);
      for(const player of recipients){const option=this.element('option','',player.name+(player.seated===false?' · 观战':''));option.value=player.id;this.target.append(option);}
    }
    this.target.value=this.selectedTarget;
    const eligible=new Map(recipients.map(player=>[player.id,player]));
    for(const seat of document.querySelectorAll('.seat[data-player-id]')){
      const player=eligible.get(seat.dataset.playerId);seat.classList.toggle('reaction-target-seat',!!player);
      if(player){seat.dataset.reactionShortcut='true';seat.tabIndex=0;seat.setAttribute('role','button');seat.setAttribute('aria-label',`${player.name}，${player.chips} 筹码，点击发表情`);}
      else if(seat.dataset.reactionShortcut){delete seat.dataset.reactionShortcut;for(const attribute of ['tabindex','role','aria-label'])seat.removeAttribute(attribute);}
    }
    const seats=(state?.game?.players||[]).filter(player=>player.seated).map(player=>player.id).join(':');
    if(seats!==this.seatSignature){this.seatSignature=seats;this.clearAnimations();}
    this.renderControls();
  }
  renderControls(){
    const connected=!!(this.state&&this.isConnected()),targets=reactionRecipients(this.state),remaining=Math.max(0,this.cooldownUntil-Date.now());
    this.openButton.disabled=!connected||!targets.length;
    this.target.disabled=!connected||!targets.length||this.pending;
    for(const button of this.emojiButtons){button.setAttribute('aria-pressed',String(button.dataset.reaction===this.selectedEmoji));button.disabled=!connected||this.pending;}
    this.sendButton.disabled=!connected||this.pending||remaining>0||!targets.some(player=>player.id===this.selectedTarget);
    this.sendButton.textContent=this.pending?'发送中…':remaining>0?`稍等 ${Math.ceil(remaining/1000)} 秒`:'发送';
    this.status.textContent=!connected?'连接后可发送':!targets.length?'等待其他朋友上线':this.pending?'正在发送表情':remaining>0?'每 2 秒可发送一次':!this.selectedTarget?'请选择接收玩家':'对方和房间里的朋友都能看到';
    if(remaining>0&&!this.cooldownTimer)this.cooldownTimer=setInterval(()=>{if(Date.now()>=this.cooldownUntil){clearInterval(this.cooldownTimer);this.cooldownTimer=null;}this.renderControls();},200);
  }
  open(targetId){
    this.update(this.getState());
    if(this.openButton.disabled){this.notice('等待其他朋友上线后再发表情');return;}
    if(reactionRecipients(this.state).some(player=>player.id===targetId))this.selectedTarget=targetId;
    this.target.value=this.selectedTarget;this.renderControls();if(!this.dialog.open)this.dialog.showModal();
  }
  submit(){
    const state=this.getState();
    if(!state||!this.isConnected()||this.pending||Date.now()<this.cooldownUntil)return;
    if(state.room.code!==this.state?.room?.code){this.reset();return;}
    if(!TABLE_REACTIONS.some(reaction=>reaction.id===this.selectedEmoji)||!reactionRecipients(state).some(player=>player.id===this.selectedTarget)){this.update(state);this.notice('对方已离开或断线，请重新选择');return;}
    this.pending=true;this.cooldownUntil=Date.now()+2000;this.renderControls();
    clearTimeout(this.pendingTimer);this.pendingTimer=setTimeout(()=>{this.pending=false;this.pendingTimer=null;this.renderControls();this.notice('表情未发送成功，请稍后重试');},5000);
    try{this.send({type:'reaction',emoji:this.selectedEmoji,to:this.selectedTarget});if(this.dialog.open)this.dialog.close();}
    catch{this.error({message:'表情发送失败，请稍后重试'});}
  }
  receive(event){
    const state=this.getState(),reaction=TABLE_REACTIONS.find(item=>item.id===event.emoji);
    if(!state||!this.isConnected()||event.room!==state.room.code||!reaction||typeof event.id!=='string'||this.seen.has(event.id))return;
    if(!state.game.players.some(player=>player.id===event.from)||!state.game.players.some(player=>player.id===event.to)||event.from===event.to)return;
    this.seen.set(event.id,Date.now());if(this.seen.size>256)this.seen.delete(this.seen.keys().next().value);
    if(event.from===state.you){this.pending=false;clearTimeout(this.pendingTimer);this.pendingTimer=null;this.cooldownUntil=Math.max(this.cooldownUntil,Date.now()+2000);this.renderControls();}
    const from=typeof event.fromName==='string'?event.fromName:'朋友',to=typeof event.toName==='string'?event.toName:'朋友';
    if(document.hidden)return;
    const text=`${from} → ${to}`;this.live.textContent=`${from} 向 ${to} 发送了${reaction.label}`;
    if(document.getElementById('page-table')?.hidden){this.notice(`${text} ${reaction.emoji}`);return;}
    this.play(event,reaction,text);
  }
  error(event){
    this.pending=false;clearTimeout(this.pendingTimer);this.pendingTimer=null;
    const retry=Number.isFinite(event.retryAfterMs)?Math.min(30000,Math.max(0,event.retryAfterMs)):0;
    this.cooldownUntil=Date.now()+retry;this.renderControls();this.notice(typeof event.message==='string'?event.message:'表情发送失败，请稍后重试');
  }
  anchor(playerId){
    const seat=[...document.querySelectorAll('.seat[data-player-id]')].find(node=>node.dataset.playerId===playerId);
    for(const node of [seat,document.getElementById('watchers'),document.querySelector('.room-title')]){
      if(!node||node.hidden)continue;const rect=node.getBoundingClientRect();if(rect.width&&rect.height)return rect;
    }
    return {left:window.innerWidth/2,top:window.innerHeight/2,width:0,height:0};
  }
  play(event,reaction,text){
    while(this.items.length>=4)this.removeItem(this.items[0]);
    const rotated=document.body.classList.contains('landscape-rotated'),width=window.innerWidth,height=window.innerHeight;
    const from=reactionPoint(this.anchor(event.from),width,height,rotated),to=reactionPoint(this.anchor(event.to),width,height,rotated);
    const node=this.element('div','reaction-flight'),pop=this.element('div','reaction-pop'+(rotated?' is-rotated':''));
    pop.append(this.element('span','reaction-flight-icon',reaction.emoji),this.element('span','reaction-flight-label',text));node.append(pop);this.layer.append(node);
    const transform=point=>`translate3d(${point.x}px,${point.y}px,0)`;node.style.transform=transform(to);
    const reduced=window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const item={node,animation:null,timer:null,arrival:null};this.items.push(item);
    if(!reduced&&typeof node.animate==='function'){
      item.animation=node.animate([{transform:transform(from),opacity:0},{transform:transform(from),opacity:1,offset:.12},{transform:transform(to),opacity:1}],{duration:560,easing:'cubic-bezier(.2,.7,.2,1)'});
      item.arrival=setTimeout(()=>node.classList.add('arrived'),560);item.timer=setTimeout(()=>this.removeItem(item),2560);
    }else{node.classList.add('arrived');item.timer=setTimeout(()=>this.removeItem(item),2000);}
  }
  removeItem(item){clearTimeout(item.timer);clearTimeout(item.arrival);item.animation?.cancel();item.node.remove();const index=this.items.indexOf(item);if(index>=0)this.items.splice(index,1);}
  clearAnimations(){for(const item of [...this.items])this.removeItem(item);}
  onLayout(){this.clearAnimations();}
  reset(){
    this.clearAnimations();clearTimeout(this.pendingTimer);clearInterval(this.cooldownTimer);this.pendingTimer=null;this.cooldownTimer=null;
    this.state=null;this.pending=false;this.cooldownUntil=0;this.selectedTarget='';this.targetSignature='';this.seatSignature='';this.seen.clear();
    if(this.dialog.open)this.dialog.close();this.live.textContent='';this.openButton.disabled=true;
  }
}

if(typeof module!=='undefined'&&module.exports)module.exports={TableReactions,TABLE_REACTIONS,reactionRecipients,reactionPoint};
