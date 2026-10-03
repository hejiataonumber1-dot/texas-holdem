const test=require('node:test'),assert=require('node:assert/strict');
const {raiseBounds,adjustRaise,validRaise,wagerBounds,adjustWager,wagerAction,seatPositions,PokerSounds}=require('../web/table-controls');
test('下注输入为本轮目标总额，已下10目标30只补20，快捷键不低于跟注目标',()=>{
 const g={bigBlind:10,currentBet:0,minRaise:10,canRaise:true},p={bet:0,chips:1990};
 assert.equal(wagerBounds(g,p).initial,0);assert.deepEqual(wagerAction(g,p,10),{type:'action',action:'raise',amount:10});
 const previous={bet:10,chips:100},target={...g,currentBet:30,minRaise:20};
 assert.deepEqual(wagerBounds(target,previous),{min:30,max:110,raiseMin:50,toCall:20,canRaise:true,allowed:true,initial:30});
 assert.deepEqual(wagerAction(target,previous,30),{type:'action',action:'call'});assert.equal(wagerAction(target,previous,20),null);
 const facing={...g,currentBet:50,minRaise:30},spent={bet:20,chips:100};const b=wagerBounds(facing,spent);
 assert.equal(b.initial,50);assert.deepEqual(wagerAction(facing,spent,50),{type:'action',action:'call'});
 assert.equal(wagerAction(facing,spent,55),null);assert.equal(adjustWager(50,5,b),55);assert.equal(adjustWager(80,-5,b),75);
 assert.equal(adjustWager(50,-100,b),50);assert.equal(adjustWager(115,100,b),120);
 assert.deepEqual(wagerAction(facing,spent,80),{type:'action',action:'raise',amount:80});
 for(const amount of [-1,0,49,55,79,121,NaN,Infinity,80.5])assert.equal(wagerAction(facing,spent,amount),null);
});
test('目标总额支持大盲过牌、跨轮零起点、短额All-in以及加注未重新开放',()=>{
 const g={bigBlind:10,currentBet:0,minRaise:10,canRaise:true},p={bet:0,chips:1990};
 assert.deepEqual(wagerAction(g,p,0),{type:'action',action:'check'});assert.equal(adjustWager(0,5,wagerBounds(g,p)),5);assert.equal(wagerAction(g,p,5),null);
 const preflop={...g,currentBet:10},bigBlind={bet:10,chips:1980};assert.equal(wagerBounds(preflop,bigBlind).initial,10);assert.deepEqual(wagerAction(preflop,bigBlind,10),{type:'action',action:'check'});assert.equal(wagerAction(preflop,bigBlind,0),null);
 const facing={...g,currentBet:50,minRaise:30},short={bet:20,chips:35};assert.equal(wagerBounds(facing,short).max,55);assert.equal(wagerBounds(facing,short).raiseMin,55);assert.deepEqual(wagerAction(facing,short,55),{type:'action',action:'raise',amount:55});assert.equal(wagerAction(facing,short,54),null);
 const insufficient={bet:20,chips:15};assert.equal(wagerBounds(facing,insufficient).initial,35);assert.deepEqual(wagerAction(facing,insufficient,35),{type:'action',action:'call'});assert.equal(wagerAction(facing,insufficient,50),null);
 const closed={...facing,canRaise:false},spent={bet:20,chips:100};assert.equal(wagerAction(closed,spent,80),null);assert.deepEqual(wagerAction(closed,spent,50),{type:'action',action:'call'});assert.equal(wagerAction(closed,short,55),null);
 const allin={bet:50,chips:0};assert.equal(wagerBounds(facing,allin).allowed,false);assert.equal(wagerAction(facing,allin,50),null);
});
test('真实三人牌局仅扣目标差额，翻牌和转牌清零本轮目标但底池保留',()=>{
 const {Game}=require('../server/poker'),game=new Game({initialChips:500,smallBlind:5,bigBlind:10});for(const id of ['a','b','c'])game.addPlayer(id,id);game.start();
 function submit(target){const player=game.players[game.turn],before=player.chips,snapshot=game.snapshot(player.id),action=wagerAction(snapshot,player,target);assert.ok(action);game.action(player.id,action.action,action.amount);return {id:player.id,paid:before-player.chips,action};}
 assert.deepEqual(submit(30),{id:'a',paid:30,action:{type:'action',action:'raise',amount:30}});
 assert.deepEqual(submit(30),{id:'b',paid:25,action:{type:'action',action:'call'}});
 assert.deepEqual(submit(30),{id:'c',paid:20,action:{type:'action',action:'call'}});
 function assertFreshStreet(phase,pot){assert.equal(game.phase,phase);assert.equal(game.currentBet,0);assert.equal(game.minRaise,10);assert.equal(game.snapshot('a').pot,pot);for(const player of game.players){assert.equal(player.bet,0);const snapshot=game.snapshot(player.id);assert.equal(wagerBounds(snapshot,player).initial,0);assert.deepEqual(wagerAction(snapshot,player,0),{type:'action',action:'check'});}}
 assertFreshStreet('flop',90);
 assert.deepEqual(submit(50),{id:'b',paid:50,action:{type:'action',action:'raise',amount:50}});
 assert.deepEqual(submit(100),{id:'c',paid:100,action:{type:'action',action:'raise',amount:100}});
 assert.deepEqual(submit(100),{id:'a',paid:100,action:{type:'action',action:'call'}});
 assert.deepEqual(submit(150),{id:'b',paid:100,action:{type:'action',action:'raise',amount:150}});
 assert.deepEqual(submit(150),{id:'c',paid:50,action:{type:'action',action:'call'}});
 assert.deepEqual(submit(150),{id:'a',paid:50,action:{type:'action',action:'call'}});
 assertFreshStreet('turn',540);assert.ok(game.players.every(p=>p.total===180&&p.chips===320));
});
test('每个玩家视角将自己的座位固定在最下方，观战保留座位顺序',()=>{
 const players=Array.from({length:9},(_,i)=>({id:String(i),seated:true}));players.push({id:'spectator',seated:false});
 for(const p of players.slice(0,9)){const positions=seatPositions(players,p.id),own=positions.find(q=>q.id===p.id);assert.equal(positions.length,9);assert.ok(Math.abs(own.x-50)<.0001);assert.equal(own.y,88);assert.equal(new Set(positions.map(q=>q.id)).size,9);}
 assert.equal(seatPositions(players,'spectator')[0].id,'0');
});
test('快捷金额累加但不能越过最小加注和总筹码，短额 All-in 与禁止加注',()=>{
  let b=raiseBounds({currentBet:20,minRaise:20,canRaise:true},{bet:10,chips:1990});
  let value=40;value=adjustRaise(value,5,b);value=adjustRaise(value,10,b);assert.equal(value,55);
  for(let i=0;i<100;i++)value=adjustRaise(value,-100,b);assert.equal(value,40);
  assert.equal(adjustRaise(1995,100,b),2000);for(const bad of [-5,20,39,2001,40.5,NaN,Infinity])assert.equal(validRaise(bad,b),false);
  b=raiseBounds({currentBet:20,minRaise:20,canRaise:true},{bet:10,chips:20});assert.deepEqual(b,{min:30,max:30,allowed:true});assert.equal(adjustRaise(30,-5,b),30);assert.equal(validRaise(30,b),true);
  assert.equal(validRaise(50,raiseBounds({currentBet:20,minRaise:20,canRaise:false},{bet:10,chips:100})),false);
});
test('发牌提示按新手牌和新增公共牌触发，十秒提醒每回合只播放一次',()=>{
  let now=0;const heard=[],sound=new PokerSounds({now:()=>now,play:k=>heard.push(k)});
  const s={you:'a',room:{code:'123456',deadline:45000},game:{hand:0,board:[],phase:'waiting',turnId:null}};
  sound.update(s);s.game.hand=1;s.game.phase='preflop';s.game.turnId='a';sound.update(s);sound.update(s);assert.deepEqual(heard,['deal']);
  now=9999;sound.tick(s);assert.equal(heard.length,1);now=10000;sound.tick(s);sound.tick(s);assert.deepEqual(heard,['deal','reminder']);
  s.game.turnId='b';s.room.deadline=55000;now=20000;sound.tick(s);assert.equal(heard.length,2);
  s.game.board=['As','Ks','Qs'];s.game.phase='flop';sound.update(s);assert.equal(heard.at(-1),'deal');
  sound.enabled=false;s.game.board.push('Js');sound.update(s);s.game.turnId='a';sound.tick(s);assert.equal(heard.length,3);
});

test('行动音效只播放新成功行动，首次加入和重连不重放，静音期间消费进度',()=>{
  const heard=[],sound=new PokerSounds({play:k=>heard.push(k)});
  const s={you:'spectator',room:{code:'123456'},game:{hand:1,board:[],lastAction:{seq:3,hand:1,kind:'call'}}};
  sound.update(s);sound.update(s);assert.deepEqual(heard,[]);
  s.game.lastAction={seq:4,hand:1,kind:'fold'};sound.update(s);sound.update(s);assert.deepEqual(heard,['fold']);
  sound.enabled=false;s.game.lastAction={seq:5,hand:1,kind:'check'};sound.update(s);
  sound.enabled=true;sound.update(s);assert.deepEqual(heard,['fold']);
  sound.previous=null;s.game.lastAction={seq:6,hand:1,kind:'raise'};sound.update(s);assert.deepEqual(heard,['fold']);
  s.game.hand=2;sound.update(s);assert.deepEqual(heard,['fold','deal']);
  s.game.lastAction={seq:7,hand:2,kind:'allin'};sound.update(s);assert.deepEqual(heard,['fold','deal','allin']);
  s.room.code='654321';s.game.lastAction={seq:50,hand:2,kind:'bet'};sound.update(s);assert.equal(heard.length,3);
});
