const test=require('node:test'),assert=require('node:assert/strict');
const {RoundDisplay}=require('../web/round-display');
const snapshot=(phase,bets,extra={})=>({room:{code:'123456'},game:{hand:1,phase,board:phase==='preflop'?[]:['2s','3h','4c'],players:bets.map((bet,i)=>({id:String(i),bet})),...extra}});

test('最后一人跟注也保留到发牌完毕，同轮更新不提前收走筹码',()=>{
  let now=0;const d=new RoundDisplay({now:()=>now});
  d.update(snapshot('preflop',[10,5]));
  const next=snapshot('flop',[0,0],{completedRound:{hand:1,phase:'preflop',bets:[{id:'0',amount:10},{id:'1',amount:10}]}});
  let view=d.update(next);assert.equal(view.markers.get('1').amount,10);assert.equal(view.firstNewCard,0);assert.equal(view.settling,true);
  now=1100;view=d.update(next);assert.equal(view.remaining,100);assert.equal(view.markers.size,2);
  now=1200;view=d.update(next);assert.equal(view.markers.size,0);assert.equal(view.settling,false);
});
test('新轮下注优先显示，不串入下一手或其他房间，首次加入不重播',()=>{
  let now=0;const d=new RoundDisplay({now:()=>now});d.update(snapshot('preflop',[50,30]));
  const next=snapshot('flop',[0,0],{completedRound:{hand:1,phase:'preflop',bets:[{id:'0',amount:50},{id:'1',amount:50}]}});
  d.update(next);now=500;const raised=snapshot('flop',[20,0],{completedRound:next.game.completedRound});
  assert.deepEqual(d.update(raised).markers.get('0'),{amount:20,settling:false});
  assert.equal(d.update(snapshot('preflop',[5,10],{hand:2})).settling,false);
  const elsewhere=snapshot('flop',[0,0]);elsewhere.room.code='654321';assert.equal(d.update(elsewhere).markers.size,0);
  d.reset();assert.equal(d.update(next).markers.size,0);
});
test('河牌结算和All-in跑完公共牌后短暂停留，过期后不显示旧筹码',()=>{
  let now=0;const d=new RoundDisplay({now:()=>now});d.update(snapshot('river',[50,20],{board:['2s','3h','4c','5s','8d']}));
  const end=snapshot('ended',[50,50],{board:['2s','3h','4c','5s','8d'],completedRound:{hand:1,phase:'river',bets:[{id:'0',amount:50},{id:'1',amount:50}]}});
  assert.equal(d.update(end).markers.get('1').amount,50);now=1201;assert.equal(d.update(end).markers.size,0);
  d.reset();d.update(snapshot('preflop',[2000,10]));
  const allin=snapshot('ended',[0,0],{board:end.game.board,completedRound:{hand:1,phase:'preflop',bets:[{id:'0',amount:2000},{id:'1',amount:2000}]}});
  const v=d.update(allin);assert.equal(v.markers.get('1').amount,2000);assert.equal(v.firstNewCard,0);
});

test('结算后下注标记变为每局净赢输，保持到下一手且重连仍显示',()=>{
  let now=0;const d=new RoundDisplay({now:()=>now});
  d.update(snapshot('river',[100,50]));
  const ended=snapshot('ended',[100,100],{completedRound:{hand:1,phase:'river',bets:[{id:'0',amount:100},{id:'1',amount:100}]},
    handResults:{hand:1,players:[{id:'0',net:120},{id:'1',net:-120},{id:'2',net:0}]}});
  assert.deepEqual(d.update(ended).markers.get('1'),{amount:100,settling:true});
  now=1200;const results=d.update(ended);
  assert.deepEqual([...results.markers.values()],[{amount:120,settling:false,result:true},{amount:-120,settling:false,result:true},{amount:0,settling:false,result:true}]);
  now=60000;assert.deepEqual(d.update(ended).markers,results.markers);
  d.reset();assert.deepEqual(d.update(ended).markers,results.markers);
  const next=snapshot('preflop',[5,10],{hand:2,handResults:ended.game.handResults});
  assert.deepEqual([...d.update(next).markers.values()],[{amount:5,settling:false},{amount:10,settling:false}]);
  assert.equal(d.update(snapshot('waiting',[0,0])).markers.size,0);
});
