const test=require('node:test');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const path=require('node:path');
const net=require('node:net');
const os=require('node:os');
const crypto=require('node:crypto');
const {WebSocket}=require('ws');

async function bankServer(t){
  const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
  const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const child=spawn(process.execPath,[path.resolve(__dirname,'../server/index.js')],{env:{...process.env,PORT:String(port),ALLOW_GUEST:'true',ROOM_CREATE_CODE:'',ADMIN_DATA_FILE:path.join(os.tmpdir(),'poker-repay-'+crypto.randomUUID()+'.json')},stdio:['ignore','pipe','pipe']});
  const peers=[];t.after(()=>{peers.forEach(peer=>peer.ws.terminate());child.kill();});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('启动超时')),5000);child.stdout.once('data',()=>{clearTimeout(timer);resolve();});child.once('error',reject);});
  return async function login(name,token){
    const ws=new WebSocket(`ws://127.0.0.1:${port}/ws`),messages=[],waiters=[],sequences=new WeakMap();let sequence=0,sendQueue=Promise.resolve();const sentAt=[];
    ws.on('message',data=>{const message=JSON.parse(data);sequences.set(message,++sequence);const index=waiters.findIndex(w=>sequence>w.after&&w.predicate(message));if(index<0)messages.push(message);else{const waiter=waiters.splice(index,1)[0];clearTimeout(waiter.timer);waiter.resolve(message);}});
    const peer={ws,send:message=>{sendQueue=sendQueue.then(async()=>{while(sentAt.length&&Date.now()-sentAt[0]>=1100)sentAt.shift();if(sentAt.length>=16){await new Promise(resolve=>setTimeout(resolve,1100-(Date.now()-sentAt[0])));while(sentAt.length&&Date.now()-sentAt[0]>=1100)sentAt.shift();}sentAt.push(Date.now());ws.send(JSON.stringify(message.type==='create'?{authorizationCode:'3333',...message}:message));});},next(predicate,afterMessage){const after=afterMessage?sequences.get(afterMessage):0,index=messages.findIndex(message=>sequences.get(message)>after&&predicate(message));if(index>=0)return Promise.resolve(messages.splice(index,1)[0]);return new Promise((resolve,reject)=>{const waiter={predicate,after,resolve,timer:setTimeout(()=>{waiters.splice(waiters.indexOf(waiter),1);reject(Error('等待消息超时'));},3000)};waiters.push(waiter);});}};
    peers.push(peer);await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
    peer.send({type:'hello',name,token});peer.auth=await peer.next(m=>m.type==='welcome');
    if(!token)await peer.next(m=>m.type==='lobby');return peer;
  };
}
const stateWhere=predicate=>m=>m.type==='state'&&predicate(m);
const stateAt=(hand,predicate)=>stateWhere(m=>m.game.hand===hand&&predicate(m));
const record=(state,id)=>state.room.summary.find(p=>p.id===id);
async function repaymentState(peer,hand,requestId,predicate){
  const acknowledgement=await peer.next(m=>m.type==='repaid'&&m.requestId===requestId);
  // Only inspect the broadcast following this acknowledgement, never an older
  // matching balance that was still in flight from another socket's command.
  return peer.next(stateAt(hand,predicate),acknowledgement);
}

test('自定义银行额度按本人整倍还款、重复不扣款，观战重连及最终结算保留记录',async t=>{
  const login=await bankServer(t),unit=100;let a=await login('银行甲'),b=await login('银行乙');const watch=await login('银行观众');
  a.send({type:'create',initialChips:unit,smallBlind:1,bigBlind:2});let state=await a.next(stateWhere(()=>true));const code=state.room.code,aid=state.you;
  b.send({type:'join',code});const joined=await b.next(stateWhere(()=>true)),bid=joined.you;
  watch.send({type:'join',code,spectator:true});await watch.next(stateWhere(()=>true));
  const latest=new Map([[a,state],[b,joined]]),getPeer=id=>id===aid?a:b,cash=id=>state.game.players.find(p=>p.id===id).chips;
  async function update(peer,message,predicate){
    peer.send(message);const values=await Promise.all([a,b].map(p=>p.next(stateWhere(predicate),latest.get(p))));
    [a,b].forEach((p,i)=>latest.set(p,values[i]));state=values[0];return state;
  }
  async function start(){const hand=state.game.hand+1;await update(a,{type:'start'},m=>m.game.hand===hand&&m.game.phase==='preflop');}
  async function action(peer,action,amount){const hand=state.game.hand;await update(peer,{type:'action',action,amount},m=>m.game.hand===hand);}
  async function borrow(peer,id){const total=record(state,id).borrowed+unit;await update(peer,{type:'rebuy',amount:999999,initialChips:1},m=>record(m,id)?.borrowed===total);assert.equal(cash(id),unit);}
  // Move a known amount through a real matched bet followed by the donor's fold.
  // Both players retain chips so the server never auto-runs an all-in showdown.
  async function donate(donorId,amount){
    const before=cash(donorId);await start();
    if(state.game.turnId!==donorId)await action(getPeer(state.game.turnId),state.game.players.find(p=>p.id===state.game.turnId).bet<state.game.currentBet?'call':'check');
    await action(getPeer(donorId),'raise',amount);await action(getPeer(state.game.turnId),'call');assert.equal(state.game.phase,'flop');
    if(state.game.turnId!==donorId)await action(getPeer(state.game.turnId),'check');
    await action(getPeer(donorId),'fold');assert.equal(state.game.phase,'ended');assert.equal(cash(donorId),before-amount);
  }
  watch.send({type:'repay',amount:unit,requestId:'outsider',playerId:aid});assert.match((await watch.next(m=>m.type==='error')).message,/银行记录/);
  b.send({type:'repay',amount:unit,requestId:'no-debt'});assert.match((await b.next(m=>m.type==='error')).message,/没有待还/);
  for(let n=0;n<32;n++){
    await start();const actor=state.game.players.find(p=>p.id===state.game.turnId);await action(getPeer(actor.id),'raise',actor.chips+actor.bet);
    await action(getPeer(state.game.turnId),'call');if(state.game.players.some(p=>p.chips===0))break;
  }
  const busted=state.game.players.find(p=>p.chips===0);assert.ok(busted,'真实比牌应产生输光玩家');
  const id=busted.id,otherId=id===aid?bid:aid;let borrower=getPeer(id);
  for(let loans=1;loans<=3;loans++){
    await borrow(borrower,id);assert.equal(record(state,id).borrowed,loans*unit);if(loans===3)break;
    for(let attempt=0;attempt<40&&cash(id)>0;attempt++){
      if(cash(otherId)===0)await borrow(getPeer(otherId),otherId);
      while(cash(id)>unit+3){const amount=Math.min(cash(id)-unit,cash(otherId)-1);assert.ok(amount>=4);await donate(id,amount);}
      await start();const actor=state.game.players.find(p=>p.id===state.game.turnId);
      const target=state.game.players.find(p=>p.id===id);await action(getPeer(actor.id),'raise',target.chips+target.bet);
      await action(getPeer(state.game.turnId),'call');
    }
    assert.equal(cash(id),0,'筹码回流限制了筹码差距，40次比牌内应再次输光');
  }
  while(cash(id)<3*unit)await donate(otherId,Math.min(3*unit-cash(id),cash(id)-1,cash(otherId)-1));
  const settledHand=state.game.hand,handResults=state.game.handResults,otherRecord=record(state,otherId),net=record(state,id).net;
  for(const amount of [1,50,101,'100',0,-100,100.5]){
    borrower.send({type:'repay',amount,requestId:'forged',initialChips:1,playerId:otherId});assert.match((await borrower.next(m=>m.type==='error')).message,/正整数|整数倍/);
  }
  borrower.send({type:'repay',amount:unit,requestId:'partial',playerId:otherId});
  const partialAck=await borrower.next(m=>m.type==='repaid'&&m.requestId==='partial');assert.deepEqual(partialAck,{type:'repaid',requestId:'partial',amount:unit});
  state=await borrower.next(stateAt(settledHand,m=>record(m,id)?.repaid===unit),partialAck);
  assert.equal(record(state,id).chips,2*unit);assert.equal(record(state,id).debt,2*unit);assert.equal(record(state,id).borrowed,3*unit);assert.equal(record(state,id).net,net);assert.deepEqual(record(state,otherId),otherRecord);assert.deepEqual(state.game.handResults,handResults);
  const eventCount=state.game.events.length,afterPartial=state.room.summary;
  borrower.send({type:'repay',amount:unit,requestId:'partial'});state=await repaymentState(borrower,settledHand,'partial',m=>record(m,id)?.repaid===unit);
  assert.deepEqual(state.room.summary,afterPartial);assert.equal(state.game.events.length,eventCount);
  borrower.send({type:'repay',amount:2*unit,requestId:'partial'});assert.match((await borrower.next(m=>m.type==='error')).message,/金额不一致/);
  borrower.send({type:'stand'});await borrower.next(stateAt(settledHand,m=>!m.game.players.find(p=>p.id===id).seated));
  borrower.send({type:'repay',amount:unit,requestId:'spectating'});state=await repaymentState(borrower,settledHand,'spectating',m=>record(m,id)?.repaid===2*unit);
  assert.equal(record(state,id).net,net);assert.equal(record(state,id).chips,unit);
  const oldBorrower=borrower;borrower=await login(busted.name,borrower.auth.token);await oldBorrower.next(m=>m.type==='replaced');
  state=await borrower.next(stateAt(settledHand,m=>record(m,id)?.repaid===2*unit));assert.equal(state.you,id);assert.equal(state.game.players.find(p=>p.id===id).seated,false);assert.equal(state.game.initialChips,unit);
  if(id===aid)a=borrower;else b=borrower;
  borrower.send({type:'repay',amount:unit,requestId:'partial'});state=await repaymentState(borrower,settledHand,'partial',m=>record(m,id)?.repaid===2*unit);assert.equal(record(state,id).chips,unit);
  borrower.send({type:'repay',amount:unit,requestId:'all'});state=await repaymentState(borrower,settledHand,'all',m=>record(m,id)?.debt===0);
  assert.equal(record(state,id).chips,0);assert.equal(record(state,id).borrowed,3*unit);assert.equal(record(state,id).repaid,3*unit);assert.equal(record(state,id).net,net);
  borrower.send({type:'seat',initialChips:999999});await borrower.next(stateAt(settledHand,m=>m.game.players.find(p=>p.id===id).seated&&record(m,id)?.repaid===3*unit));
  borrower.send({type:'rebuy'});state=await borrower.next(stateAt(settledHand,m=>record(m,id)?.borrowed===4*unit));assert.equal(record(state,id).repaid,3*unit);assert.equal(record(state,id).debt,unit);
  const nextHand=settledHand+1;await start();
  borrower.send({type:'repay',amount:unit,requestId:'during-hand'});assert.match((await borrower.next(m=>m.type==='error')).message,/本局结束/);
  if(state.game.turnId===id)await action(borrower,'call');await action(getPeer(otherId),'fold');
  const nextResults=state.game.handResults;
  borrower.send({type:'repay',amount:unit,requestId:'after-hand'});state=await repaymentState(borrower,nextHand,'after-hand',m=>record(m,id)?.repaid===4*unit);assert.deepEqual(state.game.handResults,nextResults);
  assert.equal(state.room.summary.reduce((sum,p)=>sum+p.net,0),2*unit);
  a.send({type:'finish'});state=await a.next(stateAt(nextHand,m=>m.room.finished));await b.next(stateAt(nextHand,m=>m.room.finished));const frozen=state.room.summary;
  borrower.send({type:'repay',amount:unit,requestId:'finished'});assert.match((await borrower.next(m=>m.type==='error')).message,/牌桌已结束/);
  const reopened=await login(busted.name,borrower.auth.token);state=await reopened.next(stateAt(nextHand,m=>m.room.finished));assert.deepEqual(state.room.summary,frozen);
});

test('建房筹码服务端校验、跨房额度独立、观众首次入座与重连不重置余额',async t=>{
  const login=await bankServer(t),host=await login('额度房主'),other=await login('另桌房主'),guest=await login('额度朋友'),watch=await login('额度观众');
  for(const initialChips of [null,'1000',0,-1,1.5,1000001,Number.MAX_SAFE_INTEGER]){
    host.send({type:'create',initialChips});assert.match((await host.next(m=>m.type==='error')).message,/筹码/);
  }
  host.send({type:'create',initialChips:1000,smallBlind:5,bigBlind:10});let state=await host.next(stateWhere(()=>true));const code=state.room.code,hid=state.you;
  assert.equal(state.game.initialChips,1000);assert.equal(record(state,hid).chips,1000);
  other.send({type:'create',initialChips:250});const second=await other.next(stateWhere(()=>true));assert.equal(second.game.initialChips,250);assert.equal(record(second,second.you).chips,250);
  guest.send({type:'join',code,initialChips:999999});state=await guest.next(stateWhere(()=>true));const gid=state.you;assert.equal(state.game.initialChips,1000);assert.equal(record(state,gid).chips,1000);
  watch.send({type:'join',code,spectator:true});state=await watch.next(stateWhere(()=>true));const wid=state.you;assert.equal(state.game.players.find(p=>p.id===wid).chips,0);assert.equal(record(state,wid),undefined);
  watch.send({type:'seat',initialChips:7});state=await watch.next(stateWhere(m=>!!record(m,wid)));assert.equal(record(state,wid).chips,1000);
  watch.send({type:'stand'});await watch.next(stateWhere(m=>!m.game.players.find(p=>p.id===wid).seated));
  // One real hand changes the host's balance before a disconnect/rejoin.
  host.send({type:'start'});state=await host.next(stateAt(1,m=>m.game.phase==='preflop'));await guest.next(stateAt(1,m=>m.game.phase==='preflop'));
  (state.game.turnId===hid?host:guest).send({type:'action',action:'fold'});state=await host.next(stateAt(1,m=>m.game.phase==='ended'));await guest.next(stateAt(1,m=>m.game.phase==='ended'));
  const balance=record(state,hid).chips;assert.notEqual(balance,1000);
  const restored=await login('额度房主',host.auth.token);await host.next(m=>m.type==='replaced');state=await restored.next(stateAt(1,()=>true));assert.equal(state.you,hid);assert.equal(record(state,hid).chips,balance);assert.equal(state.game.initialChips,1000);
  restored.send({type:'stand'});await restored.next(stateAt(1,m=>!m.game.players.find(p=>p.id===hid).seated));restored.send({type:'seat',initialChips:1});state=await restored.next(stateAt(1,m=>m.game.players.find(p=>p.id===hid).seated));assert.equal(record(state,hid).chips,balance);
  // Exercise loans in the two concurrently existing rooms, with independent units.
  const pairs=[[restored,guest,code,1000,1],[other,await login('另桌朋友'),second.room.code,250,0]];
  pairs[1][1].send({type:'join',code:second.room.code});await pairs[1][1].next(stateWhere(()=>true));
  for(const [owner,opponent,roomCode,unit,previousHand] of pairs){
    if(unit===250){
      // Force one room to run out as soon as blinds are posted. The other room
      // keeps normal blinds and also covers short-stack calls after a showdown.
      owner.send({type:'blinds',smallBlind:500,bigBlind:500});await owner.next(m=>m.type==='blind-settings-saved');
      await owner.next(stateAt(previousHand,m=>m.game.bigBlind===500));await opponent.next(stateAt(previousHand,m=>m.game.bigBlind===500));
    }
    let ended;for(let n=1;n<=32;n++){
      const hand=previousHand+n;owner.send({type:'start'});
      let [current,otherView]=await Promise.all([owner,opponent].map(peer=>peer.next(stateAt(hand,()=>true))));
      if(unit===250)assert.equal(current.game.phase,'ended','短筹码被盲注扣完时，开局广播直接结算');
      for(let actionCount=0;current.game.phase!=='ended';actionCount++){
        assert.ok(actionCount<12,'两人 All-in 应在有限行动内结束');
        const ownerActs=current.game.turnId===current.you,actor=ownerActs?owner:opponent,view=ownerActs?current:otherView;
        const player=view.game.players.find(p=>p.id===view.you),amount=player.chips+player.bet;
        const action=view.game.canRaise&&amount>view.game.currentBet?'raise':view.game.toCall?'call':'check';
        const sequence=view.game.lastAction?.seq||0;
        actor.send({type:'action',action,amount});
        [current,otherView]=await Promise.all([owner.next(stateAt(hand,m=>(m.game.lastAction?.seq||0)>sequence),current),opponent.next(stateAt(hand,m=>(m.game.lastAction?.seq||0)>sequence),otherView)]);
      }
      ended=current;
      if(ended.game.players.some(player=>player.seated&&player.chips===0))break;
    }
    const busted=ended.game.players.find(p=>p.seated&&p.chips===0);assert.ok(busted);const borrower=busted.id===ended.you?owner:opponent;
    borrower.send({type:'rebuy',amount:other===borrower?1000:250,initialChips:1});const borrowed=await borrower.next(stateAt(ended.game.hand,m=>record(m,busted.id)?.borrowed===unit));assert.equal(record(borrowed,busted.id).chips,unit);assert.equal(borrowed.game.initialChips,unit);assert.equal(borrowed.room.code,roomCode);
    borrower.send({type:'repay',amount:unit===1000?250:100,requestId:'cross-unit',initialChips:1});assert.match((await borrower.next(m=>m.type==='error')).message,/整数倍/);
    borrower.send({type:'repay',amount:unit,requestId:'full-own-unit'});const repaid=await repaymentState(borrower,ended.game.hand,'full-own-unit',m=>record(m,busted.id)?.debt===0);assert.equal(record(repaid,busted.id).repaid,unit);assert.equal(record(repaid,busted.id).chips,0);assert.equal(repaid.game.initialChips,unit);
  }
});
