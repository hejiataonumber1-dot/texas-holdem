// Keep the finished street's chips visible while the next cards are revealed.
// This is presentation state only; betting always uses the latest server state.
class RoundDisplay {
  constructor({now=Date.now,duration=1200}={}){this.now=now;this.duration=duration;this.reset();}
  reset(){this.previous=null;this.transition=null;}
  update(state){
    const g=state.game,identity=state.room.code+':'+g.hand,now=this.now(),old=this.previous;
    if(!old||old.identity!==identity)this.transition=null;
    else if(old.phase!==g.phase&&!['waiting','ended'].includes(old.phase)){
      const completed=g.completedRound;
      const bets=completed?.hand===g.hand&&completed.phase===old.phase?completed.bets:old.bets;
      this.transition={until:now+this.duration,started:now,bets,firstNewCard:old.boardLength};
    }
    this.previous={identity,phase:g.phase,boardLength:g.board.length,bets:g.players.filter(p=>p.bet>0).map(p=>({id:p.id,amount:p.bet}))};
    if(this.transition?.until<=now)this.transition=null;
    const active=this.transition,markers=new Map();
    if(active)for(const bet of active.bets)markers.set(bet.id,{amount:bet.amount,settling:true});
    if(!['waiting','ended'].includes(g.phase))for(const p of g.players)if(p.bet>0)markers.set(p.id,{amount:p.bet,settling:false});
    if(g.phase==='ended'&&!active&&g.handResults?.hand===g.hand){
      for(const result of g.handResults.players)markers.set(result.id,{amount:result.net,settling:false,result:true});
    }
    return {markers,settling:!!active,remaining:active?active.until-now:0,elapsed:active?now-active.started:0,
      firstNewCard:active?.firstNewCard??g.board.length};
  }
  get settling(){return !!this.transition&&this.now()<this.transition.until;}
}
if(typeof module!=='undefined')module.exports={RoundDisplay};
