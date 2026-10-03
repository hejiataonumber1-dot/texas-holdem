const test=require('node:test');
const assert=require('node:assert/strict');
const {Game,evaluate,compare}=require('../server/poker');
function game(n=2){const g=new Game({initialChips:500});for(let i=0;i<n;i++)g.addPlayer(String(i),'玩家'+i);return g;}
function act(g,type,amount){g.action(g.players[g.turn].id,type,amount);}
function sum(g){return g.players.reduce((n,p)=>n+p.chips,0);}

test('同名或同身份不会创建重复玩家',()=>{
  const g=new Game({initialChips:500});g.addPlayer('a','Alice');assert.equal(g.players[0].chips,500);
  assert.throws(()=>g.addPlayer('a','其他昵称'),/已在房间/);
  assert.throws(()=>g.addPlayer('b',' ＡＬＩＣＥ '),/已在房间/);
  assert.equal(g.players.length,1);
});

test('踢人保留底池贡献，非当前玩家被踢不跳过当前回合，结算后释放座位',()=>{
  const g=game(3),all=[...g.players];g.start();const actor=g.players[g.turn].id;
  g.removePlayer('2');assert.equal(g.players[g.turn].id,actor);assert.equal(g.snapshot('0').pot,30);
  assert.equal(g.snapshot('0').players.some(p=>p.id==='2'),false);assert.equal(all[2].folded,true);
  while(g.playing())act(g,g.snapshot(g.players[g.turn].id).toCall?'call':'check');g.pruneRemoved();
  assert.equal(g.players.length,2);assert.equal(all.reduce((n,p)=>n+p.chips,0),1500);
  g.start();assert.equal(g.players.some(p=>p.id==='2'),false);assert.equal(g.players[g.turn].pendingRemove,undefined);
});

test('被踢的 All-in 底牌正常结算，清理后记录仍可取到最终筹码',()=>{
  const g=game(3),all=[...g.players];all[0].chips=50;g.start();act(g,'raise',50);const actor=g.players[g.turn].id;
  g.removePlayer('0');assert.equal(all[0].folded,false);assert.equal(g.players[g.turn].id,actor);
  act(g,'call');act(g,'call');assert.equal(g.phase,'flop');
  g.phase='river';g.board=['2s','3d','7h','9c','Js'];all.forEach((p,i)=>p.cards=[['As','Ad'],['Ks','Kd'],['Qs','Qd']][i]);
  g.removePlayer('1');assert.equal(g.phase,'ended');assert.equal(all[0].chips,150);
  assert.equal(all.reduce((n,p)=>n+p.chips,0),1050);assert.deepEqual(g.players.map(p=>p.id),['2']);
  assert.deepEqual(g.snapshot('2').handResults.players,[{id:'0',net:100},{id:'1',net:-50},{id:'2',net:-50}]);
});

test('边池所有有资格者被踢后退回无人可结算的层，不会丢失筹码或卡住牌局',()=>{
  const g=game(3),all=[...g.players];g.phase='river';g.board=['2s','3d','7h','9c','Js'];g.turn=1;g.currentBet=10;
  all.forEach((p,i)=>Object.assign(p,{inHand:true,cards:[['As','Ad'],['Ks','Kd'],['Qs','Qd']][i],chips:i?1900:0,total:i?100:50,bet:i===1?10:0}));
  g.removePlayer('1');assert.equal(g.phase,'river');assert.equal(g.players[g.turn].id,'2');g.removePlayer('2');
  assert.equal(g.phase,'ended');assert.deepEqual(all.map(p=>p.chips),[150,1950,1950]);assert.equal(all.reduce((n,p)=>n+p.chips,0),4050);
});

test('主动离房自动弃牌并推进当前回合，All-in 离房仍结算且保留原账本对象',()=>{
  const {TableLedger}=require('../server/table-ledger');
  const g=game(3),all=[...g.players],ledger=new TableLedger({initialChips:500});all.forEach(p=>ledger.seat(p));
  all[0].chips=50;g.start();act(g,'raise',50);g.removePlayer('0',{reason:'leave'});
  assert.equal(all[0].folded,false);assert.equal(g.players[g.turn].id,'1');
  assert.match(g.events.at(-1),/玩家0 离开房间，已 All-in/);assert.equal(g.events.some(e=>e.includes('被房主')),false);
  act(g,'call');act(g,'call');g.phase='river';g.board=['2s','3d','7h','9c','Js'];
  all.forEach((p,i)=>p.cards=[['As','Ad'],['Ks','Kd'],['Qs','Qd']][i]);
  g.removePlayer('1',{reason:'leave'});
  assert.equal(g.phase,'ended');assert.equal(all[1].folded,true);assert.equal(all[0].chips,150);
  assert.ok(g.events.some(e=>e==='玩家1 离开房间，自动弃牌'));
  assert.equal(ledger.summary().reduce((sum,p)=>sum+p.chips,0),1050);
  assert.deepEqual(ledger.summary().map(p=>p.chips),[150,450,450]);
  assert.deepEqual(g.players.map(p=>p.id),['2']);
});

test('每手底注独立于本轮盲注，短筹码与边池守恒，观众不缴纳',()=>{
  const g=new Game({initialChips:500,smallBlind:5,bigBlind:10,ante:10});for(let i=0;i<3;i++)g.addPlayer(String(i),'玩家'+i);g.addPlayer('watch','观众',false);g.players[0].chips=7;
  g.start();assert.deepEqual(g.players.map(p=>p.bet),[0,5,10,0]);assert.equal(g.snapshot('1').pot,42);assert.equal(g.players[0].total,7);assert.equal(g.players[0].cards.length,2);
  assert.throws(()=>g.setBlinds(10,20),/本局结束/);while(g.playing())act(g,g.snapshot(g.players[g.turn].id).toCall?'call':'check');assert.equal(sum(g),1007);
  g.setBlinds(10,20);assert.equal(g.ante,10);for(const [sb,bb] of [[0,10],[10,5],[5,2.5],[5,2001]])assert.throws(()=>g.setBlinds(sb,bb));
  const h=new Game({initialChips:500,smallBlind:5,bigBlind:10,ante:10});h.addPlayer('a','甲');h.addPlayer('b','乙');h.players.forEach(p=>p.chips=5);h.start();assert.equal(h.phase,'ended');assert.equal(h.board.length,5);assert.equal(sum(h),10);
});
test('本局输赢包含底注和盲注，弃牌者记负数，观众不计入',()=>{
  const g=new Game({initialChips:500,smallBlind:5,bigBlind:10,ante:10});
  for(let i=0;i<3;i++)g.addPlayer(String(i),'玩家'+i);
  g.addPlayer('watch','观众',false);
  assert.equal(g.snapshot('0').handResults,null);
  g.start();assert.equal(g.snapshot('0').handResults,null);
  act(g,'fold');act(g,'fold');
  const results={hand:1,players:[{id:'0',net:-10},{id:'1',net:-15},{id:'2',net:25}]};
  assert.deepEqual(g.snapshot('0').handResults,results);
  assert.deepEqual(g.players.slice(0,3).map(p=>p.chips-500),results.players.map(p=>p.net));
  // Later borrowing, leaving a seat or removing a player cannot rewrite a settled hand.
  g.players[0].chips+=1000;g.stand('0');g.removePlayer('1');
  assert.deepEqual(g.snapshot('2').handResults,results);
  assert.throws(()=>g.start(),/至少需要/);
  assert.deepEqual(g.snapshot('2').handResults,results);
  g.addPlayer('next','新玩家');g.start();
  assert.equal(g.hand,2);assert.equal(g.snapshot('2').handResults,null);
});
test('底注耗尽短筹码并自动跑完牌时仍记录整手净输赢',()=>{
  const g=new Game({initialChips:500,smallBlind:5,bigBlind:10,ante:10});
  g.addPlayer('a','甲');g.addPlayer('b','乙');g.addPlayer('watch','观众',false);
  const initial=[7,5];g.players.slice(0,2).forEach((p,i)=>p.chips=initial[i]);
  g.start();assert.equal(g.phase,'ended');assert.equal(g.board.length,5);
  const {hand,players}=g.snapshot('a').handResults;
  assert.equal(hand,1);assert.deepEqual(players.map(p=>p.id),['a','b']);
  assert.deepEqual(players.map(p=>p.net),g.players.slice(0,2).map((p,i)=>p.chips-initial[i]));
  assert.equal(players.reduce((total,p)=>total+p.net,0),0);
});
test('观战不占座位或发牌，满座仍可观战，预约离座不改变本局底池',()=>{
  const g=game(9);assert.throws(()=>g.addPlayer('full','满座玩家'),/座位已满/);g.addPlayer('watch','观众',false);g.start();
  assert.equal(g.players.at(-1).inHand,false);assert.deepEqual(g.players.at(-1).cards,[]);const player=g.players[g.turn],pot=g.snapshot(player.id).pot;
  g.stand(player.id);assert.equal(player.pendingStand,true);assert.equal(player.seated,true);assert.equal(g.snapshot(player.id).pot,pot);
  act(g,'fold');g.stand(player.id);assert.equal(player.seated,false);assert.equal(player.pendingStand,false);
  while(g.playing())act(g,g.snapshot(g.players[g.turn].id).toCall?'call':'check');assert.equal(sum(g),4500);
  g.start();assert.equal(player.inHand,false);assert.deepEqual(player.cards,[]);
});
test('牌型排序、A2345 顺子和七张牌最佳组合',()=>{
  const hands=[['As','Kd','9h','5s','3d'],['As','Ad','9h','5s','3d'],['As','Ad','9h','9s','3d'],['As','Ad','Ah','5s','3d'],['As','2d','3h','4s','5d'],['As','Ks','9s','5s','3s'],['As','Ad','Ah','5s','5d'],['As','Ad','Ah','Ac','3d'],['As','2s','3s','4s','5s']];
  hands.forEach((h,i)=>assert.equal(evaluate(h)[0],i));
  for(let i=1;i<hands.length;i++)assert.ok(compare(evaluate(hands[i]),evaluate(hands[i-1]))>0);
  assert.deepEqual(evaluate(['As','2d','3h','4s','5d','Kc','Qc']),[4,5]);
  assert.deepEqual(evaluate(['As','Ad','Ah','Ks','Kd','Kh','2c']),[6,14,13]);
  assert.throws(()=>evaluate(['As','As','Ah','Ks','Kd']));
});
test('单挑按钮为小盲、翻牌前先行动、翻牌后大盲先行动',()=>{
  const g=game();g.start();assert.equal(g.button,0);assert.equal(g.turn,0);
  assert.deepEqual(g.players.map(p=>p.bet),[10,20]);
  act(g,'call');assert.equal(g.turn,1);act(g,'check');assert.equal(g.phase,'flop');assert.equal(g.turn,1);assert.equal(g.board.length,3);
  while(g.playing())act(g,g.snapshot(g.players[g.turn].id).toCall?'call':'check');
  assert.equal(g.board.length,5);assert.equal(sum(g),1000);
  g.start();assert.equal(g.button,1);
});
test('私有底牌、非法行动与弃牌结算',()=>{
  const g=game(3);g.start();const actor=g.players[g.turn];
  const view=g.snapshot(actor.id);assert.equal(view.players.find(p=>p.id===actor.id).cards.includes('??'),false);
  assert.deepEqual(view.players.find(p=>p.id!==actor.id).cards,['??','??']);
  assert.throws(()=>g.action(g.players[(g.turn+1)%3].id,'call'),/还没轮到/);
  assert.throws(()=>act(g,'check'),/需要跟注/);
  assert.throws(()=>act(g,'raise',21),/至少加注/);
  act(g,'fold');act(g,'fold');assert.equal(g.phase,'ended');assert.equal(sum(g),1500);
  assert.ok(g.snapshot(actor.id).players.filter(p=>p.id!==actor.id).every(p=>p.cards.every(c=>c==='??')));
});

test('多人摊牌自动公开未弃牌者，弃牌者仍可手动亮牌且下一手重新保密',()=>{
  const g=game(4);g.addPlayer('watch','观众',false);g.start();act(g,'fold');
  while(g.playing()){
    assert.ok(g.snapshot('watch').players.filter(p=>p.inHand).every(p=>!p.revealed&&p.handName===''&&p.cards.every(c=>c==='??')));
    act(g,g.snapshot(g.players[g.turn].id).toCall?'call':'check');
  }
  const observer=g.snapshot('watch');
  for(const p of g.players.filter(p=>p.inHand&&!p.folded)){
    const publicPlayer=observer.players.find(q=>q.id===p.id);
    assert.equal(publicPlayer.revealed,true);assert.deepEqual(publicPlayer.cards,p.cards);assert.ok(publicPlayer.handName);
  }
  const folded=g.players.find(p=>p.folded),privatePlayer=observer.players.find(p=>p.id===folded.id);
  assert.equal(privatePlayer.revealed,false);assert.equal(privatePlayer.handName,'');assert.deepEqual(privatePlayer.cards,['??','??']);
  const settled=JSON.stringify({chips:g.players.map(p=>p.chips),pots:g.pots,handResults:g.handResults});
  assert.equal(g.reveal(folded.id,g.hand),true);
  for(const viewer of ['0','1','2','watch']){
    const publicPlayer=g.snapshot(viewer).players.find(p=>p.id===folded.id);
    assert.equal(publicPlayer.revealed,true);assert.deepEqual(publicPlayer.cards,folded.cards);
  }
  const events=[...g.events];assert.equal(g.reveal(folded.id,g.hand),false);assert.deepEqual(g.events,events);
  assert.equal(JSON.stringify({chips:g.players.map(p=>p.chips),pots:g.pots,handResults:g.handResults}),settled);
  g.start();assert.equal(g.hand,2);
  assert.ok(g.snapshot('watch').players.every(p=>!p.revealed&&p.handName===''));
  assert.ok(g.snapshot('watch').players.filter(p=>p.inHand).every(p=>p.cards.every(c=>c==='??')));
});

test('弃牌后仍可自愿亮牌，观众、无底牌者和离房者不能亮牌',()=>{
  const g=game();g.addPlayer('watch','观众',false);g.start();
  const folded=g.players[g.turn];act(g,'fold');g.stand(folded.id);
  assert.equal(folded.folded,true);assert.equal(folded.seated,false);
  assert.ok(g.snapshot('watch').players.filter(p=>p.inHand).every(p=>!p.revealed&&p.handName===''&&p.cards.every(c=>c==='??')));
  assert.deepEqual(g.snapshot('watch').players.find(p=>p.id===folded.id).cards,['??','??']);
  assert.equal(g.reveal(folded.id,g.hand),true);
  assert.deepEqual(g.snapshot('watch').players.find(p=>p.id===folded.id).cards,folded.cards);
  assert.throws(()=>g.reveal('watch',g.hand),/没有参与/);
  assert.throws(()=>g.reveal('missing',g.hand),/没有参与/);
  g.players[1].pendingRemove=true;assert.throws(()=>g.reveal('1',g.hand),/没有参与/);
});

test('亮牌仅限当前已结束的牌局，缺失、过期与伪造手号均拒绝',()=>{
  const g=game();assert.throws(()=>g.reveal('0',0),/本局结束/);g.start();
  assert.throws(()=>g.reveal('0',g.hand),/本局结束/);act(g,'fold');
  for(const hand of [undefined,null,'1',0,2,1.5])assert.throws(()=>g.reveal('0',hand),/牌局已更新/);
  assert.equal(g.players[0].revealed,false);g.start();act(g,'fold');
  assert.throws(()=>g.reveal('0',1),/牌局已更新/);assert.equal(g.players[0].revealed,false);
  assert.equal(g.reveal('0',2),true);
});
test('短额 All-in 不重新开放加注，但尚未行动者可加注',()=>{
  const g=game(3);g.players[0].chips=30;g.start(); // action order 0, 1, 2
  act(g,'raise',30);assert.equal(g.minRaise,20);assert.equal(g.currentBet,30);
  assert.equal(g.snapshot('1').canRaise,true);act(g,'raise',50);assert.equal(g.currentBet,50);
  assert.equal(g.snapshot('2').canRaise,true);
  const h=game(3);h.players[2].chips=30;h.start();act(h,'call');act(h,'call');act(h,'raise',30);
  assert.equal(h.snapshot('0').canRaise,false);assert.throws(()=>act(h,'raise',50),/未重新开放/);act(h,'call');act(h,'call');
  assert.equal(h.phase,'flop');assert.equal(h.snapshot(h.players[h.turn].id).canRaise,true);
});
test('主池、边池和未跟注金额分别结算',()=>{
  const g=game(3);g.phase='river';g.board=['2s','3d','7h','9c','Js'];
  const holes=[['As','Ad'],['Ks','Kd'],['Qs','Qd']];
  g.players.forEach((p,i)=>Object.assign(p,{inHand:true,cards:holes[i],chips:0,total:[50,100,200][i]}));
  g.finish();assert.deepEqual(g.players.map(p=>p.chips),[150,100,100]);
  assert.deepEqual(g.pots.map(p=>p.amount),[150,100,100]);assert.equal(g.pots[2].refund,true);
  assert.deepEqual(g.snapshot('0').handResults.players,[{id:'0',net:100},{id:'1',net:0},{id:'2',net:-100}]);
  assert.deepEqual(g.snapshot('watch').players.map(p=>p.cards),holes);
  assert.ok(g.snapshot('watch').players.every(p=>p.revealed&&p.handName==='一对'));
});
test('平分底池的奇数筹码按按钮左侧优先',()=>{
  const g=game(3);g.phase='river';g.button=0;g.board=['As','Ks','Qs','Js','Ts'];
  g.players.forEach((p,i)=>Object.assign(p,{inHand:true,cards:[['2d','3d'],['4d','5d'],['6d','7d']][i],chips:0,total:1,folded:i===2}));
  g.finish();assert.deepEqual(g.players.map(p=>p.chips),[1,2,0]);
  assert.deepEqual(g.snapshot('0').handResults.players,[{id:'0',net:0},{id:'1',net:1},{id:'2',net:-1}]);
});
test('两人 All-in 自动发完公共牌，筹码守恒',()=>{
  const g=game();g.start();act(g,'raise',500);act(g,'call');assert.equal(g.phase,'ended');assert.equal(g.board.length,5);assert.equal(sum(g),1000);
  for(const p of g.snapshot('watch').players){assert.equal(p.revealed,true);assert.ok(p.handName);assert.deepEqual(p.cards,g.players.find(q=>q.id===p.id).cards);}
});
test('换轮展示包含最后跟注的完整公开下注，当前轮仍清零',()=>{
  const g=game(3);g.start();act(g,'raise',60);act(g,'call');act(g,'call');
  const view=g.snapshot('0');assert.equal(view.phase,'flop');assert.equal(view.currentBet,0);
  assert.deepEqual(view.players.map(p=>p.bet),[0,0,0]);
  assert.deepEqual(view.completedRound,{hand:1,phase:'preflop',bets:[{id:'0',amount:60},{id:'1',amount:60},{id:'2',amount:60}]});
  assert.equal(view.lastAction.phase,'preflop');assert.equal(view.lastAction.bet,60);assert.equal(view.lastAction.amount,40);
  assert.equal(view.pot,180);assert.equal(sum(g),1320);
});
test('All-in 连续发完公共牌保留最后非空下注快照',()=>{
  const g=game();g.start();act(g,'raise',500);act(g,'call');
  const view=g.snapshot('0');assert.equal(view.phase,'ended');assert.equal(view.board.length,5);
  assert.deepEqual(view.players.map(p=>p.bet),[0,0]);
  assert.deepEqual(view.completedRound,{hand:1,phase:'preflop',bets:[{id:'0',amount:500},{id:'1',amount:500}]});
  assert.equal(sum(g),1000);
});
test('河牌结算快照只含河牌最终下注，不累计之前轮次',()=>{
  const g=game();g.start();
  while(g.phase!=='river')act(g,g.snapshot(g.players[g.turn].id).toCall?'call':'check');
  act(g,'raise',80);act(g,'call');const view=g.snapshot('0');
  assert.equal(view.phase,'ended');
  assert.deepEqual(view.completedRound,{hand:1,phase:'river',bets:[{id:'0',amount:80},{id:'1',amount:80}]});
  assert.equal(view.lastAction.phase,'river');assert.equal(view.lastAction.bet,80);
  assert.deepEqual(view.players.map(p=>p.total),[100,100]);assert.equal(sum(g),1000);
});
test('弃牌结算保留本轮下注展示，下一手清空上手快照',()=>{
  const g=game();assert.equal(g.snapshot('0').completedRound,null);g.start();act(g,'raise',60);act(g,'fold');
  assert.equal(g.phase,'ended');
  assert.deepEqual(g.snapshot('0').completedRound,{hand:1,phase:'preflop',bets:[{id:'0',amount:60},{id:'1',amount:20}]});
  assert.equal(sum(g),1000);g.start();
  assert.equal(g.hand,2);assert.equal(g.snapshot('0').completedRound,null);assert.equal(g.currentBet,20);
});
test('牌局中加入的玩家下一局才获底牌',()=>{
  const g=game();g.start();g.addPlayer('2','新朋友');assert.equal(g.players[2].inHand,false);assert.deepEqual(g.snapshot('2').players[2].cards,[]);
  act(g,'fold');g.start();assert.equal(g.players[2].cards.length,2);
});
test('随机多人行动保持筹码守恒、牌不重复和有限结束',()=>{
  let seed=12345;function random(){seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;}
  for(let n=2;n<=9;n++)for(let round=0;round<40;round++){
    const g=game(n);g.players.forEach(p=>p.chips=1+Math.floor(random()*2000));const initial=sum(g);g.start();
    let steps=0;
    while(g.playing()){
      assert.ok(++steps<500);const p=g.players[g.turn],s=g.snapshot(p.id),roll=random();
      if(roll<.15)act(g,'fold');
      else if(roll<.45&&s.canRaise&&p.bet+p.chips>g.currentBet){const target=Math.min(p.bet+p.chips,g.currentBet+g.minRaise+Math.floor(random()*100));act(g,'raise',target);}
      else act(g,s.toCall?'call':'check');
    }
    assert.equal(sum(g),initial);const all=[...g.board,...g.players.flatMap(p=>p.cards)];assert.equal(new Set(all).size,all.length);
  }
});

test('房间初始筹码可配置且仅首次入座发放，快照公开本桌额度',()=>{
  for(const initialChips of [1,1000,1000000]){
    const g=new Game({initialChips});g.addPlayer('a','甲');g.addPlayer('b','乙');g.addPlayer('w','观众',false);
    assert.deepEqual(g.players.map(p=>p.chips),[initialChips,initialChips,0]);assert.equal(g.snapshot('a').initialChips,initialChips);
  }
  for(const initialChips of [0,-1,1.2,'1000',null,NaN,Infinity,1000001,Number.MAX_SAFE_INTEGER])assert.throws(()=>new Game({initialChips}),/筹码/);
  const g=new Game({initialChips:1000,smallBlind:5,bigBlind:10});g.addPlayer('a','甲');g.addPlayer('b','乙');
  g.start();act(g,'fold');const balances=g.players.map(p=>p.chips);g.start();
  g.players.forEach((p,i)=>assert.equal(p.chips+p.bet,balances[i]));assert.equal(g.snapshot('a').initialChips,1000);
});
