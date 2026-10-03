const test=require('node:test');
const assert=require('node:assert/strict');
const {TableLedger}=require('../server/table-ledger');
test('累计借款与负净筹码，离开重新入座不能重置',()=>{
  const ledger=new TableLedger({initialChips:500}),a={id:'a',name:'玩家甲',chips:0},b={id:'b',name:'玩家乙',chips:4000};
  const game={players:[a,b],playing:()=>false,log:()=>{}};ledger.seat(a);ledger.seat(b);
  ledger.borrow(game,'a');assert.equal(a.chips,500);assert.equal(ledger.summary()[0].borrowed,500);
  assert.throws(()=>ledger.borrow(game,'a'),/输光/);
  a.chips=0;b.chips+=500;ledger.borrow(game,'a');a.chips=300;b.chips+=200;
  assert.deepEqual(ledger.summary()[0],{id:'a',name:'玩家甲',chips:300,borrowed:1000,repaid:0,debt:1000,net:-700});
  assert.equal(ledger.summary().reduce((sum,p)=>sum+p.net,0),4000);
  const rejoined={id:'a',name:'重新入座',chips:2000};ledger.seat(rejoined);
  assert.equal(rejoined.chips,300);assert.equal(ledger.summary()[0].borrowed,1000);assert.equal(ledger.summary()[0].net,-700);
  assert.throws(()=>ledger.borrow({...game,playing:()=>true},'a'),/本局结束/);
});
test('每次输光都可继续借入，长期累计借款全部从最终筹码扣除',()=>{
  const ledger=new TableLedger({initialChips:500}),a={id:'a',name:'玩家甲',chips:0,seated:true},b={id:'b',name:'玩家乙',chips:4000,seated:true};
  const game={players:[a,b],playing:()=>false,log:()=>{}};ledger.seat(a);ledger.seat(b);
  for(let round=1;round<=100;round++){
    ledger.borrow(game,'a');
    assert.equal(a.chips,500);
    assert.equal(ledger.summary().find(p=>p.id==='a').borrowed,round*500);
    assert.throws(()=>ledger.borrow(game,'a'),/输光/);
    assert.equal(a.chips,500);
    assert.equal(ledger.summary().find(p=>p.id==='a').borrowed,round*500);
    // The opponent wins these chips before the next loan becomes eligible.
    b.chips+=a.chips;a.chips=0;
  }
  const summary=ledger.summary();
  assert.deepEqual(summary.find(p=>p.id==='a'),{id:'a',name:'玩家甲',chips:0,borrowed:50000,repaid:0,debt:50000,net:-50000});
  assert.equal(summary.reduce((sum,p)=>sum+p.net,0),4000);
});
test('已有借款的观战者须重新入座，拒绝借款不改变余额或债务',()=>{
  const ledger=new TableLedger({initialChips:500}),player={id:'a',name:'玩家甲',chips:0,seated:true};
  const game={players:[player],playing:()=>false,log:()=>{}};ledger.seat(player);
  ledger.borrow(game,player.id);player.chips=0;player.seated=false;
  const before=ledger.summary();
  assert.throws(()=>ledger.borrow(game,player.id),/重新入座/);
  assert.deepEqual(ledger.summary(),before);
  player.seated=true;ledger.borrow(game,player.id);
  assert.deepEqual(ledger.summary()[0],{id:'a',name:'玩家甲',chips:500,borrowed:1000,repaid:0,debt:1000,net:-500});
});

test('按初始筹码的整数倍部分还款与全部还款，保留借入总额和净筹码',()=>{
  const ledger=new TableLedger({initialChips:500}),player={id:'a',name:'玩家甲',chips:0,seated:true},opponent={id:'b',name:'玩家乙',chips:4000,seated:true};
  const game={players:[player,opponent],playing:()=>false,log:()=>{}};ledger.seat(player);ledger.seat(opponent);
  for(let n=0;n<3;n++){ledger.borrow(game,'a');if(n<2){opponent.chips+=player.chips;player.chips=0;}}
  player.chips+=750;opponent.chips-=750;
  const initialNet=ledger.summary()[0].net;
  ledger.repay(game,'a',500,'partial');
  assert.deepEqual(ledger.summary()[0],{id:'a',name:'玩家甲',chips:750,borrowed:1500,repaid:500,debt:1000,net:-250});
  assert.equal(ledger.summary()[0].net,initialNet);assert.equal(ledger.summary().reduce((sum,p)=>sum+p.net,0),4000);
  ledger.repay(game,'a',500,'balance');assert.equal(player.chips,250);assert.equal(ledger.summary()[0].debt,500);
  assert.throws(()=>ledger.repay(game,'a',500,'insufficient'),/现有筹码不足/);
  player.chips+=250;opponent.chips-=250;ledger.repay(game,'a',500,'remaining-debt');
  assert.deepEqual(ledger.summary()[0],{id:'a',name:'玩家甲',chips:0,borrowed:1500,repaid:1500,debt:0,net:0});
  assert.equal(ledger.summary().reduce((sum,p)=>sum+p.net,0),4000);
  ledger.borrow(game,'a');assert.equal(ledger.summary()[0].borrowed,2000);assert.equal(ledger.summary()[0].repaid,1500);assert.equal(ledger.summary()[0].debt,500);
});

test('还款拒绝无效或不整倍金额、超余额欠款、局中和无记录，失败不改变账目',()=>{
  const ledger=new TableLedger({initialChips:500}),player={id:'a',name:'玩家甲',chips:0,seated:true},watch={id:'w',name:'观众',chips:0,seated:false};
  const game={players:[player,watch],playing:()=>false,log:()=>{}};ledger.seat(player);
  assert.throws(()=>ledger.repay(game,'a',500,'no-debt'),/没有待还/);
  assert.throws(()=>ledger.repay(game,'w',500,'spectator'),/银行记录/);
  assert.throws(()=>ledger.repay(game,'missing',500,'absent'),/银行记录/);
  ledger.borrow(game,'a');player.chips=300;const before=ledger.summary();
  for(const amount of [0,-1,0.1,'500',NaN,Infinity,null,{},Number.MAX_SAFE_INTEGER+1])assert.throws(()=>ledger.repay(game,'a',amount,'bad-amount'),/正整数/);
  for(const amount of [1,100,499,501,750])assert.throws(()=>ledger.repay(game,'a',amount,'not-a-unit'),/整数倍/);
  for(const requestId of [undefined,null,0,'','  ','x'.repeat(101)])assert.throws(()=>ledger.repay(game,'a',500,requestId),/请求无效/);
  assert.throws(()=>ledger.repay(game,'a',1000,'too-much-debt'),/超过待还/);
  assert.throws(()=>ledger.repay(game,'a',500,'too-much-cash'),/现有筹码不足/);
  assert.throws(()=>ledger.repay({...game,playing:()=>true},'a',500,'live'),/本局结束/);
  assert.deepEqual(ledger.summary(),before);
  player.chips=500;ledger.repay(game,'a',500,'bad-amount');assert.equal(player.chips,0);
});

test('还款请求幂等且缓存有界，观战与重入座保留还款历史',()=>{
  const ledger=new TableLedger({initialChips:5}),player={id:'a',name:'玩家甲',chips:0,seated:true},logs=[];
  const game={players:[player],playing:()=>false,log:message=>logs.push(message)};ledger.seat(player);
  for(let n=0;n<102;n++){player.chips=0;ledger.borrow(game,'a');}player.chips=510;
  player.seated=false;assert.equal(ledger.repay(game,'a',5,'first'),5);
  const after=ledger.summary(),logCount=logs.length;
  assert.equal(ledger.repay(game,'a',5,'first'),5);
  assert.equal(ledger.repay({...game,playing:()=>true},'a',5,'first'),5);
  assert.throws(()=>ledger.repay(game,'a',10,'first'),/金额不一致/);
  assert.deepEqual(ledger.summary(),after);assert.equal(logs.length,logCount);
  const returned={id:'a',name:'玩家甲',chips:2000,seated:false};ledger.seat(returned);game.players=[returned];
  assert.equal(returned.chips,505);assert.deepEqual(ledger.summary(),after);ledger.repay(game,'a',5,'first');assert.equal(returned.chips,505);
  for(let n=0;n<101;n++)ledger.repay(game,'a',5,'small-'+n);
  assert.equal(ledger.records.get('a').repayments.size,100);
  const latest=ledger.summary();ledger.repay(game,'a',5,'small-100');assert.deepEqual(ledger.summary(),latest);assert.equal(latest[0].debt,0);
});

test('银行单位按各桌初始筹码独立设置，非法初始值不创建账本',()=>{
  for(const initialChips of [0,-1,1.5,'1000',null,NaN,Infinity,1000001,Number.MAX_SAFE_INTEGER])assert.throws(()=>new TableLedger({initialChips}),/筹码/);
  for(const initialChips of [1,1000,1000000]){
    const ledger=new TableLedger({initialChips}),player={id:'a',name:'甲',chips:0,seated:true},game={players:[player],playing:()=>false,log:()=>{}};
    ledger.seat(player);ledger.borrow(game,'a');assert.equal(player.chips,initialChips);assert.equal(ledger.summary()[0].borrowed,initialChips);
    if(initialChips>1)assert.throws(()=>ledger.repay(game,'a',initialChips-1,'invalid'),/整数倍/);
    ledger.repay(game,'a',initialChips,'full');assert.equal(player.chips,0);assert.equal(ledger.summary()[0].debt,0);
  }
});
