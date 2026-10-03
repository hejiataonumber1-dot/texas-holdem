function raiseBounds(game,player){
  const max=player.bet+player.chips,min=Math.min(game.currentBet+game.minRaise,max);
  return {min,max,allowed:game.canRaise&&max>game.currentBet};
}
function adjustRaise(value,delta,bounds){
  const start=Number.isSafeInteger(Number(value))?Number(value):bounds.min;
  return Math.min(bounds.max,Math.max(bounds.min,start+delta));
}
function validRaise(value,bounds){return Number.isSafeInteger(value)&&bounds.allowed&&value>=bounds.min&&value<=bounds.max;}
function wagerBounds(game,player){
  const toCall=Math.max(0,game.currentBet-player.bet),max=player.bet+player.chips;
  const min=Math.min(max,game.currentBet);
  const raiseMin=Math.min(max,Math.max(game.bigBlind,game.currentBet+game.minRaise));
  const canRaise=game.canRaise&&max>game.currentBet;
  const allowed=player.chips>0;
  const initial=min;
  return {min,max,raiseMin,toCall,canRaise,allowed,initial};
}
function adjustWager(value,delta,bounds){
  return adjustRaise(value,delta,bounds);
}
function wagerAction(game,player,amount){
  const b=wagerBounds(game,player);
  if(!Number.isSafeInteger(amount)||amount<0||amount>b.max||!b.allowed)return null;
  if(amount===player.bet&&b.toCall===0)return {type:'action',action:'check'};
  if(amount===Math.min(game.currentBet,b.max)&&b.toCall>0)return {type:'action',action:'call'};
  if(!b.canRaise||amount<b.min||amount<b.raiseMin)return null;
  return {type:'action',action:'raise',amount};
}
function seatPositions(players,you){
  const seated=players.filter(p=>p.seated),own=seated.findIndex(p=>p.id===you),anchor=own<0?0:own;
  return seated.map((p,index)=>{const angle=Math.PI/2+(index-anchor)*Math.PI*2/seated.length;return {id:p.id,x:50+36*Math.cos(angle),y:50+38*Math.sin(angle)};});
}
const SOUND_PATTERNS={
  deal:{notes:[1200,800],step:.09,duration:.075,wave:'triangle',volume:.055},
  reminder:{notes:[620,830,620],step:.12,duration:.09,wave:'sine',volume:.07},
  bet:{notes:[1600,1100,1500],step:.055,duration:.04,wave:'triangle',volume:.045},
  call:{notes:[1000,1250],step:.065,duration:.05,wave:'triangle',volume:.045},
  raise:{notes:[1000,1400,1800],step:.065,duration:.055,wave:'triangle',volume:.05},
  check:{notes:[650,850],step:.07,duration:.045,wave:'sine',volume:.045},
  fold:{notes:[420,240],step:.07,duration:.075,wave:'triangle',volume:.045},
  allin:{notes:[700,1000,1400,2000],step:.06,duration:.05,wave:'triangle',volume:.055}
};
class PokerSounds{
  constructor({now=Date.now,play}={}){this.now=now;this.enabled=true;this.previous=null;this.warned=null;this.play=play||((kind)=>this.tone(kind));}
  unlock(){try{this.context??=new(window.AudioContext||window.webkitAudioContext)();this.context.resume().catch(()=>{});}catch{}}
  tone(kind){const c=this.context;if(!this.enabled||c?.state!=='running')return;
    const pattern=SOUND_PATTERNS[kind];if(!pattern)return;
    // Queue short cues so an action followed by dealing does not mask either sound.
    const start=Math.max(c.currentTime,Math.min(this.nextToneAt||0,c.currentTime+.8));
    pattern.notes.forEach((frequency,i)=>{const o=c.createOscillator(),gain=c.createGain(),at=start+i*pattern.step;o.type=pattern.wave;o.frequency.value=frequency;gain.gain.setValueAtTime(.0001,at);gain.gain.exponentialRampToValueAtTime(pattern.volume,at+.006);gain.gain.exponentialRampToValueAtTime(.0001,at+pattern.duration);o.connect(gain);gain.connect(c.destination);o.start(at);o.stop(at+pattern.duration+.005);o.onended=()=>{o.disconnect();gain.disconnect();};});
    this.nextToneAt=start+(pattern.notes.length-1)*pattern.step+pattern.duration+.025;
  }
  update(state){const action=state.game.lastAction,next={room:state.room.code,hand:state.game.hand,board:state.game.board.length,actionSeq:action?.seq||0};
    if(this.previous?.room===next.room&&this.enabled){
      if(action?.hand===next.hand&&next.actionSeq>this.previous.actionSeq&&['bet','call','raise','check','fold','allin'].includes(action.kind))this.play(action.kind);
      if(next.hand>this.previous.hand||next.board>this.previous.board)this.play('deal');
    }
    this.previous=next;
  }
  tick(state){if(!state||state.game.turnId!==state.you||!state.room.deadline)return;
    const key=[state.room.code,state.game.hand,state.game.phase,state.room.deadline].join(':');
    if(this.enabled&&this.warned!==key&&this.now()>=state.room.deadline-35000&&this.now()<state.room.deadline){this.warned=key;this.play('reminder');}
  }
}
if(typeof module!=='undefined')module.exports={raiseBounds,adjustRaise,validRaise,wagerBounds,adjustWager,wagerAction,seatPositions,PokerSounds};
