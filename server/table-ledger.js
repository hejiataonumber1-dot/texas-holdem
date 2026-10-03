const {DEFAULT_INITIAL_CHIPS,validateInitialChips}=require('./chip-policy');

class TableLedger {
  constructor({initialChips=DEFAULT_INITIAL_CHIPS}={}){this.initialChips=validateInitialChips(initialChips);this.records=new Map();}
  seat(player){
    const previous=this.records.get(player.id);
    if(previous){player.chips=previous.player.chips;previous.player=player;}
    else this.records.set(player.id,{player,borrowed:0,repaid:0,repayments:new Map()});
  }
  borrow(game,id){
    if(game.playing())throw Error('本局结束后才能借筹码');
    const player=game.players.find(p=>p.id===id),record=this.records.get(id);
    if(!player||!record)throw Error('请先入座');
    if(player.seated===false)throw Error('请先重新入座后再借筹码');
    if(player.chips!==0)throw Error('筹码输光后才能向系统借筹码');
    if(!Number.isSafeInteger(record.borrowed+this.initialChips))throw Error('累计借筹码已达上限');
    record.borrowed+=this.initialChips;player.chips=this.initialChips;
    game.log(`${player.name} 向系统借入 ${this.initialChips.toLocaleString()} 筹码 · 累计 ${record.borrowed.toLocaleString()}`);
  }
  repay(game,id,amount,requestId){
    if(!Number.isSafeInteger(amount)||amount<=0)throw Error('还款筹码必须是正整数');
    if(amount%this.initialChips!==0)throw Error(`还款须为开局筹码 ${this.initialChips.toLocaleString()} 的整数倍`);
    if(typeof requestId!=='string'||!requestId.trim()||requestId.length>100)throw Error('还款请求无效，请刷新页面后重试');
    const player=game.players.find(p=>p.id===id),record=this.records.get(id);
    if(!player||!record)throw Error('没有你的银行记录，请先入座');
    const previous=record.repayments.get(requestId);
    if(previous!==undefined){
      if(previous!==amount)throw Error('还款请求金额不一致，请重新操作');
      return previous;
    }
    if(game.playing())throw Error('本局结束后才能归还筹码');
    const debt=record.borrowed-record.repaid;
    if(debt===0)throw Error('目前没有待还筹码');
    if(amount>debt)throw Error(`还款不能超过待还的 ${debt.toLocaleString()} 筹码`);
    if(amount>player.chips)throw Error('现有筹码不足，请减少还款金额');
    player.chips-=amount;record.repaid+=amount;
    record.repayments.set(requestId,amount);
    if(record.repayments.size>100)record.repayments.delete(record.repayments.keys().next().value);
    game.log(`${player.name} 向银行归还 ${amount.toLocaleString()} 筹码 · 待还 ${(debt-amount).toLocaleString()}`);
    return amount;
  }
  summary(){return [...this.records.values()].map(({player,borrowed,repaid})=>({id:player.id,name:player.name,chips:player.chips,borrowed,repaid,debt:borrowed-repaid,net:player.chips-borrowed+repaid}));}
}
module.exports={TableLedger};
