const crypto = require('node:crypto');
const {nameKey}=require('./player-name');
const {DEFAULT_INITIAL_CHIPS,validateInitialChips}=require('./chip-policy');
const RANKS = '23456789TJQKA';
const SUITS = 'shdc';
const NAMES = ['高牌','一对','两对','三条','顺子','同花','葫芦','四条','同花顺'];

function compare(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0); if (d) return d;
  }
  return 0;
}
function five(cards) {
  const ranks = cards.map(c => RANKS.indexOf(c[0]) + 2).sort((a,b) => b-a);
  const counts = new Map(); ranks.forEach(r => counts.set(r, (counts.get(r)||0)+1));
  const groups = [...counts].sort((a,b) => b[1]-a[1] || b[0]-a[0]);
  const flush = cards.every(c => c[1] === cards[0][1]);
  const unique = [...new Set(ranks)]; if (unique[0] === 14) unique.push(1);
  let straight = 0;
  for(let i=0;i<=unique.length-5;i++) if(unique[i]-unique[i+4]===4) { straight=unique[i]; break; }
  if(flush && straight) return [8, straight];
  if(groups[0][1]===4) return [7,groups[0][0],groups[1][0]];
  if(groups[0][1]===3 && groups[1][1]===2) return [6,groups[0][0],groups[1][0]];
  if(flush) return [5,...ranks];
  if(straight) return [4,straight];
  if(groups[0][1]===3) return [3,groups[0][0],...groups.slice(1).map(g=>g[0])];
  if(groups[0][1]===2 && groups[1][1]===2) return [2,groups[0][0],groups[1][0],groups[2][0]];
  if(groups[0][1]===2) return [1,groups[0][0],...groups.slice(1).map(g=>g[0])];
  return [0,...ranks];
}
function evaluate(cards) {
  if(cards.length<5 || cards.length>7 || new Set(cards).size !== cards.length || cards.some(c => !/^[2-9TJQKA][shdc]$/.test(c))) throw Error('无效牌组');
  let best = [-1];
  for(let a=0;a<cards.length-4;a++) for(let b=a+1;b<cards.length-3;b++)
    for(let c=b+1;c<cards.length-2;c++) for(let d=c+1;d<cards.length-1;d++)
      for(let e=d+1;e<cards.length;e++) { const score=five([cards[a],cards[b],cards[c],cards[d],cards[e]]); if(compare(score,best)>0) best=score; }
  return best;
}
function shuffle() {
  const deck = [...RANKS].flatMap(r=>[...SUITS].map(s=>r+s));
  for(let i=deck.length-1;i>0;i--) { const j=crypto.randomInt(i+1); [deck[i],deck[j]]=[deck[j],deck[i]]; }
  return deck;
}
class Game {
  constructor({ante=0,smallBlind=10,bigBlind=20,initialChips=DEFAULT_INITIAL_CHIPS}={}) { this.initialChips=validateInitialChips(initialChips); this.setAnte(ante); this.players=[]; this.button=-1; this.phase='waiting'; this.board=[]; this.pots=[]; this.currentBet=0; this.minRaise=bigBlind; this.turn=null; this.hand=0; this.completedRound=null; this.handResults=null; this.events=[]; this.smallBlind=smallBlind; this.bigBlind=bigBlind; this.setBlinds(smallBlind,bigBlind); }
  setBlinds(smallBlind,bigBlind){if(!Number.isSafeInteger(smallBlind)||!Number.isSafeInteger(bigBlind)||smallBlind<1||bigBlind<smallBlind||bigBlind>2000)throw Error('盲注须为整数：1 ≤ 小盲 ≤ 大盲 ≤ 2,000');if(this.playing())throw Error('本局结束后才能修改盲注');this.smallBlind=smallBlind;this.bigBlind=bigBlind;this.minRaise=bigBlind;}
  setAnte(ante){if(!Number.isSafeInteger(ante)||ante<0||ante>2000)throw Error('每手底注需要 0～2,000 的整数');if(this.playing&&this.phase&&this.playing())throw Error('本局结束后才能修改底注');this.ante=ante;}
  addPlayer(id,name,seated=true) {
    if(this.players.some(p=>p.id===id||nameKey(p.name)===nameKey(name)))throw Error('此玩家已在房间内');
    if(this.players.length>=30)throw Error('房间已满（含观众最多 30 人）');
    if(seated&&this.players.filter(p=>p.seated!==false).length>=9) throw Error('座位已满（最多 9 人），可以选择观战');
    this.players.push({id,name,seated,chips:seated?this.initialChips:0,cards:[],revealed:false,folded:false,inHand:false,bet:0,total:0,acted:false,lastActedBet:null});
  }
  removePlayer(id,{reason='kick'}={}){
    const p=this.players.find(p=>p.id===id&&!p.pendingRemove);
    if(!p)throw Error('玩家已离开房间');
    const oldTurn=this.turn;
    p.pendingRemove=true;p.seated=false;p.pendingStand=false;
    const active=this.playing()&&p.inHand&&!p.folded;
    this.log(`${p.name} ${reason==='leave'?'离开房间':'被房主移出房间'}${active?p.chips===0?'，已 All-in 的筹码仍按本局结算':'，自动弃牌':''}`);
    // Keep contributions until settlement; an all-in hand has no actions left.
    if(this.playing()&&p.inHand&&!p.folded&&p.chips>0){
      p.folded=true;p.acted=true;
      if(this.active().length===1)this.finish();
      else this.setNextTurn((oldTurn-1+this.players.length)%this.players.length);
    }
    this.pruneRemoved();
  }
  pruneRemoved(){
    for(let i=this.players.length-1;i>=0;i--){
      const p=this.players[i];
      if(!p.pendingRemove||(this.playing()&&(p.inHand||p.total>0)))continue;
      this.players.splice(i,1);if(i<=this.button)this.button--;
      if(this.turn!==null&&i<this.turn)this.turn--;
    }
  }
  stand(id){
    const p=this.players.find(p=>p.id===id);
    if(!p||p.seated===false)throw Error('你已经在观战');
    if(this.playing()&&p.inHand&&!p.folded){p.pendingStand=true;this.log(`${p.name} 将在本局结算后离座观战`);return;}
    p.seated=false;p.pendingStand=false;this.log(`${p.name} 离开座位，留在房间观战`);
  }
  active() { return this.players.filter(p=>p.inHand&&!p.folded); }
  playing() { return !['waiting','ended'].includes(this.phase); }
  next(index, predicate) {
    for(let n=1;n<=this.players.length;n++) { const j=(index+n)%this.players.length; if(predicate(this.players[j])) return j; }
    return -1;
  }
  pay(p,amount) { const paid=Math.min(amount,p.chips); p.chips-=paid; p.bet+=paid; p.total+=paid; return paid; }
  log(message) { this.events.push(message); this.events=this.events.slice(-16); }
  reveal(id,hand) {
    if(this.phase!=='ended')throw Error('本局结束后才能亮牌');
    if(!Number.isSafeInteger(hand)||hand!==this.hand)throw Error('牌局已更新，请重新查看本局底牌');
    const player=this.players.find(p=>p.id===id&&!p.pendingRemove);
    if(!player||!player.inHand||player.cards.length!==2)throw Error('你没有参与本局，无法亮牌');
    if(player.revealed)return false;
    player.revealed=true;this.log(`${player.name} 亮出了本局底牌`);return true;
  }
  shuffleSeats() {
    if(this.playing())throw Error('本局结束后才能随机换位');
    const slots=this.players.map((p,index)=>p.seated!==false&&!p.pendingRemove?index:-1).filter(index=>index>=0);
    if(slots.length<2)throw Error('至少需要两位在座玩家才能随机换位');
    const original=slots.map(index=>this.players[index]),shuffled=[...original];
    // Redraw the unchanged permutation so every allowed new order stays equally likely.
    do {
      for(let i=shuffled.length-1;i>0;i--){const j=crypto.randomInt(i+1);[shuffled[i],shuffled[j]]=[shuffled[j],shuffled[i]];}
    } while(shuffled.every((player,index)=>player===original[index]));
    slots.forEach((slot,index)=>{this.players[slot]=shuffled[index];});
    this.button=-1;this.turn=null;
    this.log('所有在座玩家已同意，随机换位完成；下一局按新顺序开始');
  }
  start() {
    if(this.playing()) throw Error('本局还没有结束');
    if(this.players.filter(p=>p.seated!==false&&p.chips>0).length<2) throw Error('至少需要两位有筹码的入座玩家');
    this.hand++; this.board=[]; this.pots=[]; this.completedRound=null; this.handResults=null; this.events=[]; this.deck=shuffle(); this.phase='preflop';
    for(const p of this.players) Object.assign(p,{cards:[],revealed:false,inHand:p.seated!==false&&p.chips>0,folded:false,bet:0,total:0,acted:false,lastActedBet:null,handName:''});
    this.button=this.next(this.button,p=>p.inHand);
    const headsUp=this.active().length===2;
    const sb=headsUp?this.button:this.next(this.button,p=>p.inHand);
    const bb=this.next(sb,p=>p.inHand);
    // Deal one card at a time, starting left of the button.
    for(let round=0;round<2;round++) { let i=this.button; for(let n=0;n<this.active().length;n++) { i=this.next(i,p=>p.inHand); this.players[i].cards.push(this.deck.pop()); } }
    for(const p of this.players.filter(p=>p.inHand)){const paid=Math.min(this.ante,p.chips);p.chips-=paid;p.total+=paid;}
    this.pay(this.players[sb],this.smallBlind); this.pay(this.players[bb],this.bigBlind);
    this.currentBet=this.bigBlind; this.minRaise=this.bigBlind;
    this.log(`第 ${this.hand} 局开始 · 盲注 ${this.smallBlind}/${this.bigBlind}${this.ante?' · 每手底注 '+this.ante:''}`);
    this.setNextTurn(bb);
  }
  needsAction(p) { return p.inHand&&!p.folded&&p.chips>0&&(!p.acted||p.bet<this.currentBet); }
  canRaise(p) { return p.lastActedBet===null || this.currentBet-p.lastActedBet>=this.minRaise; }
  action(id,type,amount) {
    if(!this.playing() || this.turn===null || this.players[this.turn].id!==id) throw Error('还没轮到你操作');
    const p=this.players[this.turn], oldTurn=this.turn;
    const toCall=Math.max(0,this.currentBet-p.bet),beforeChips=p.chips,beforeBet=this.currentBet;
    if(type==='fold') { p.folded=true; this.log(`${p.name} 弃牌`); }
    else if(type==='check') { if(toCall) throw Error('需要跟注或弃牌'); this.log(`${p.name} 过牌`); }
    else if(type==='call') { if(!toCall) throw Error('当前可过牌'); const paid=this.pay(p,toCall); this.log(`${p.name} ${p.chips===0?'All-in':'跟注'} ${paid}`); }
    else if(type==='raise') {
      if(!Number.isSafeInteger(amount) || amount<=this.currentBet || amount>p.bet+p.chips) throw Error('加注总额无效');
      if(!this.canRaise(p)) throw Error('不足额 All-in 未重新开放加注，你可以跟注或弃牌');
      if(!this.active().some(q=>q.id!==id&&q.chips>0)) throw Error('其他玩家都已 All-in，不能继续加注');
      const increase=amount-this.currentBet;
      if(increase<this.minRaise && amount!==p.bet+p.chips) throw Error(`至少加注到 ${this.currentBet+this.minRaise}`);
      this.pay(p,amount-p.bet);
      if(increase>=this.minRaise) { this.minRaise=increase; this.players.forEach(q=>{ if(q!==p) q.acted=false; }); }
      this.currentBet=amount; this.log(`${p.name} ${p.chips===0?'All-in':'加注到'} ${amount}`);
    } else throw Error('未知操作');
    p.acted=true; p.lastActedBet=this.currentBet;
    this.lastAction={seq:(this.lastAction?.seq||0)+1,hand:this.hand,phase:this.phase,playerId:id,bet:p.bet,
      kind:p.chips===0&&['call','raise'].includes(type)?'allin':type==='raise'?(beforeBet===0?'bet':'raise'):type,amount:beforeChips-p.chips};
    if(this.active().length===1) { this.finish(); return; }
    this.setNextTurn(oldTurn);
  }
  setNextTurn(after) {
    // A sole player with chips only needs to act if still facing a bet.
    const capable=this.active().filter(p=>p.chips>0);
    if(capable.length<=1 && capable.every(p=>p.bet>=this.currentBet)) { this.runout(); return; }
    const next=this.next(after,p=>this.needsAction(p));
    if(next<0) { this.advance(); return; }
    this.turn=next;
  }
  captureCompletedRound() {
    // Public display data only; zero-bet all-in streets must not erase the last contributions.
    const bets=this.players.filter(p=>p.bet>0).map(p=>({id:p.id,amount:p.bet}));
    if(bets.length)this.completedRound={hand:this.hand,phase:this.phase,bets};
  }
  street() {
    this.captureCompletedRound();
    this.deck.pop(); // burn
    if(this.phase==='preflop') { this.board.push(this.deck.pop(),this.deck.pop(),this.deck.pop()); this.phase='flop'; }
    else if(this.phase==='flop') { this.board.push(this.deck.pop()); this.phase='turn'; }
    else if(this.phase==='turn') { this.board.push(this.deck.pop()); this.phase='river'; }
    this.currentBet=0; this.minRaise=this.bigBlind;
    this.players.forEach(p=>{p.bet=0;p.acted=false;p.lastActedBet=null;});
  }
  advance() {
    if(this.phase==='river') { this.finish(); return; }
    this.street(); this.setNextTurn(this.button);
  }
  runout() { while(this.phase!=='river') this.street(); this.finish(); }
  finish() {
    this.captureCompletedRound();
    const remaining=this.active();
    const participants=this.players.filter(p=>p.inHand);
    // Final payouts minus this hand's contributions include antes, blinds and refunds.
    const beforePayout=new Map(participants.map(p=>[p.id,p.chips]));
    const levels=[...new Set(this.players.map(p=>p.total).filter(Boolean))].sort((a,b)=>a-b);
    const scores=new Map(remaining.length>1?remaining.map(p=>[p.id,evaluate([...p.cards,...this.board])]):[]);
    let previous=0;
    this.pots=[];
    for(const level of levels) {
      const contributors=this.players.filter(p=>p.total>=level);
      const layer=level-previous,amount=layer*contributors.length; previous=level;
      const eligible=contributors.filter(p=>p.inHand&&!p.folded);
      // Uncalled top layer is returned, including when its contributor folded.
      if(contributors.length===1) { contributors[0].chips+=amount; this.pots.push({amount,winners:[contributors[0].name],refund:true}); continue; }
      if(!eligible.length){
        if(!contributors.some(p=>p.pendingRemove))throw Error('底池没有有效玩家');
        for(const p of contributors)p.chips+=layer;
        this.pots.push({amount,winners:contributors.map(p=>p.name),refund:true,removed:true});continue;
      }
      let winners=eligible;
      if(remaining.length>1) { let best=[-1]; for(const p of eligible) if(compare(scores.get(p.id),best)>0) best=scores.get(p.id); winners=eligible.filter(p=>compare(scores.get(p.id),best)===0); }
      // Odd chips go to winners closest to the left of the button.
      winners.sort((a,b)=>((this.players.indexOf(a)-this.button-1+this.players.length)%this.players.length)-((this.players.indexOf(b)-this.button-1+this.players.length)%this.players.length));
      winners.forEach((p,i)=>p.chips+=Math.floor(amount/winners.length)+(i<amount%winners.length?1:0));
      this.pots.push({amount,winners:winners.map(p=>p.name),refund:false});
    }
    for(const p of remaining) p.handName=scores.has(p.id)?NAMES[scores.get(p.id)[0]]:'';
    this.handResults={hand:this.hand,players:participants.map(p=>({id:p.id,net:p.chips-beforePayout.get(p.id)-p.total}))};
    this.phase='ended'; this.turn=null;
    // Only players who actually reached showdown reveal automatically; folded hands stay private.
    if(remaining.length>1)for(const p of remaining)p.revealed=true;
    this.log(this.pots.map(p=>`${p.winners.join('、')}${p.removed?' 收回无人可结算的边池筹码':p.refund?' 收回未跟注筹码':' 赢得'} ${p.amount}`).join('；'));
  }
  snapshot(id) {
    const me=this.players.find(p=>p.id===id), actor=this.turn===null?null:this.players[this.turn];
    const visible=this.players.filter(p=>!p.pendingRemove),button=visible.findIndex(p=>p.id===this.players[this.button]?.id);
    return {phase:this.phase,hand:this.hand,board:this.board,button,turnId:actor?.id||null,currentBet:this.currentBet,minRaise:this.minRaise,
      pot:this.playing()?this.players.reduce((n,p)=>n+p.total,0):this.pots.filter(p=>!p.refund).reduce((n,p)=>n+p.amount,0),
      pots:this.pots,events:this.events,lastAction:this.lastAction||null,completedRound:this.completedRound,handResults:this.handResults,smallBlind:this.smallBlind,bigBlind:this.bigBlind,ante:this.ante,initialChips:this.initialChips,
      players:visible.map(p=>({id:p.id,name:p.name,seated:p.seated!==false,pendingStand:!!p.pendingStand,chips:p.chips,bet:p.bet,total:p.total,folded:p.folded,inHand:p.inHand,
        revealed:!!p.revealed,cards:p.id===id||(this.phase==='ended'&&p.revealed)?p.cards:p.cards.map(()=> '??'),handName:this.phase==='ended'&&(p.id===id||p.revealed)?p.handName||'':''})),
      canRaise:!!(me&&actor===me&&this.canRaise(me)&&this.active().some(p=>p!==me&&p.chips>0)),toCall:me?Math.max(0,this.currentBet-me.bet):0};
  }
}
module.exports={Game,evaluate,compare};
