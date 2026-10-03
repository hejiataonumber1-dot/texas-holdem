const test=require('node:test');
const assert=require('node:assert/strict');
const {Game}=require('../server/poker');
const {TableLedger}=require('../server/table-ledger');
const {SeatShuffleVote}=require('../server/seat-shuffle');

function fixture(){
  let now=1000,nextId=0,changes=0;
  const timers=[],sessions=new Map(),game=new Game({initialChips:500,smallBlind:5,bigBlind:10});
  for(const [id,seated] of [['a',true],['watch',false],['b',true],['c',true]]){
    game.addPlayer(id,id,seated);sessions.set(id,{room:'123456',ws:{readyState:1}});
  }
  const room={code:'123456',ownerId:'a',game,finished:false,seatVote:null};
  const voting=new SeatShuffleVote({sessions,now:()=>now,createId:()=>`vote-${++nextId}`,onChange:()=>changes++,
    setTimer:(fn,delay)=>{const timer={fn,delay,cleared:false};timers.push(timer);return timer;},clearTimer:timer=>{if(timer)timer.cleared=true;}});
  return {room,voting,sessions,timers,setNow:value=>{now=value;},get changes(){return changes;}};
}
const ids=game=>game.players.map(player=>player.id);

test('换位保留玩家对象、旁观槽位和结算账本，下局按新顺序重新发大小盲',()=>{
  const {room}=fixture(),game=room.game,ledger=new TableLedger({initialChips:500});
  for(const player of game.players.filter(p=>p.seated))ledger.seat(player);
  game.start();while(game.playing())game.action(game.players[game.turn].id,'fold');
  // Exercise a real debt record without changing a settled hand's results.
  const debtor=game.players.find(p=>p.id==='b');debtor.chips=0;ledger.borrow(game,debtor.id);debtor.chips=0;ledger.borrow(game,debtor.id);debtor.chips+=500;ledger.repay(game,debtor.id,500,'repaid-before-shuffle');
  game.reveal('a',game.hand);
  const order=ids(game),objects=new Map(game.players.map(p=>[p.id,p])),data=new Map(game.players.map(p=>[p.id,structuredClone(p)]));
  const summary=ledger.summary(),hand=game.hand,board=[...game.board],results=structuredClone(game.handResults),pot=game.snapshot('a').pot;
  game.shuffleSeats();
  assert.notDeepEqual(ids(game),order);assert.equal(game.players[1].id,'watch');assert.equal(game.button,-1);assert.equal(game.turn,null);
  for(const player of game.players){assert.equal(player,objects.get(player.id));assert.deepEqual(player,data.get(player.id));}
  assert.deepEqual(ledger.summary(),summary);assert.deepEqual(game.handResults,results);assert.deepEqual(game.board,board);assert.equal(game.hand,hand);assert.equal(game.snapshot('a').pot,pot);
  const seats=game.players.filter(p=>p.seated),chips=new Map(seats.map(p=>[p.id,p.chips]));game.start();
  assert.equal(game.players[game.button].id,seats[0].id);assert.equal(seats[0].bet,0);assert.equal(seats[1].bet,5);assert.equal(seats[2].bet,10);assert.equal(game.players[game.turn].id,seats[0].id);
  for(const player of seats)assert.equal(player.chips,chips.get(player.id)-player.bet);
  assert.equal(game.hand,hand+1);assert.equal(game.players[1].inHand,false);
});

test('换位必须全票同意，重复同意不重复计票，拒绝及旧投票不能改变顺序',()=>{
  const {room,voting}=fixture(),before=ids(room.game),vote=voting.request(room,'a');
  assert.deepEqual(vote.participantIds,['a','b','c']);assert.deepEqual(vote.approvedIds,['a']);assert.equal(vote.expiresAt,61000);
  assert.throws(()=>voting.request(room,'a'),/已有/);assert.throws(()=>voting.vote(room,'watch',vote.id,true),/在座/);
  assert.throws(()=>voting.vote(room,'b',vote.id,'true'),/同意或拒绝/);
  voting.vote(room,'b',vote.id,true);voting.vote(room,'b',vote.id,true);
  assert.deepEqual(room.seatVote.approvedIds,['a','b']);assert.deepEqual(ids(room.game),before);
  voting.vote(room,'c',vote.id,false);assert.equal(room.seatVote,null);assert.deepEqual(ids(room.game),before);
  const next=voting.request(room,'a');assert.notEqual(next.id,vote.id);
  assert.throws(()=>voting.vote(room,'c',vote.id,true),/结束或更新/);assert.deepEqual(next.approvedIds,['a']);
  voting.vote(room,'b',next.id,true);voting.vote(room,'c',next.id,true);const shuffled=ids(room.game);
  assert.equal(room.seatVote,null);assert.notDeepEqual(shuffled,before);
  assert.throws(()=>voting.vote(room,'c',next.id,true),/结束或更新/);assert.deepEqual(ids(room.game),shuffled);
});

test('投票到期取消且延迟消息不生效，旧计时器不会取消新一轮投票',()=>{
  const f=fixture(),{room,voting,timers}=f,before=ids(room.game);
  const first=voting.request(room,'a');assert.equal(timers[0].delay,60000);
  f.setNow(first.expiresAt);assert.throws(()=>voting.vote(room,'b',first.id,true),/结束或更新/);
  assert.equal(room.seatVote,null);assert.equal(timers[0].cleared,true);assert.equal(f.changes,1);assert.deepEqual(ids(room.game),before);
  const second=voting.request(room,'a');timers[0].fn();assert.equal(room.seatVote.id,second.id);assert.equal(f.changes,1);
  f.setNow(second.expiresAt);timers[1].fn();assert.equal(room.seatVote,null);assert.equal(f.changes,2);assert.deepEqual(ids(room.game),before);
});

test('掉线、人数变化或房主变更使当前同意失效，观战房主也不能代替在座玩家同意',()=>{
  for(const change of [f=>{f.sessions.get('b').ws=null;},f=>{f.room.game.stand('b');},f=>{f.room.game.players.find(p=>p.id==='watch').seated=true;},f=>{f.room.ownerId='b';}]){
    const f=fixture(),before=ids(f.room.game);f.voting.request(f.room,'a');change(f);
    assert.equal(f.voting.validate(f.room),true);assert.equal(f.room.seatVote,null);assert.deepEqual(ids(f.room.game),before);
  }
  const {room,voting}=fixture();room.ownerId='watch';const vote=voting.request(room,'watch');assert.deepEqual(vote.approvedIds,[]);
  assert.throws(()=>voting.vote(room,'watch',vote.id,true),/在座/);
  voting.vote(room,'a',vote.id,true);voting.vote(room,'b',vote.id,true);assert.ok(room.seatVote);
  voting.vote(room,'c',vote.id,true);assert.equal(room.seatVote,null);
});

test('局中、结束牌桌、离线及不足两人不能发起，只有房主可以取消',()=>{
  const f=fixture(),{room,voting}=f;assert.throws(()=>voting.request(room,'b'),/房主/);
  f.sessions.get('b').ws=null;assert.throws(()=>voting.request(room,'a'),/在线/);f.sessions.get('b').ws={readyState:1};
  const vote=voting.request(room,'a');assert.throws(()=>voting.cancel(room,'b',vote.id),/房主/);assert.ok(room.seatVote);
  voting.cancel(room,'a',vote.id);assert.equal(room.seatVote,null);assert.throws(()=>voting.cancel(room,'a',vote.id),/结束或更新/);
  room.game.start();assert.throws(()=>voting.request(room,'a'),/本局结束/);assert.throws(()=>room.game.shuffleSeats(),/本局结束/);
  while(room.game.playing())room.game.action(room.game.players[room.game.turn].id,'fold');
  room.finished=true;assert.throws(()=>voting.request(room,'a'),/牌桌已结束/);room.finished=false;
  room.game.stand('b');room.game.stand('c');assert.throws(()=>voting.request(room,'a'),/至少/);assert.throws(()=>room.game.shuffleSeats(),/至少/);
});
