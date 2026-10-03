const test=require('node:test');
const assert=require('node:assert/strict');
const {RoomReactions,REACTION_COOLDOWN_MS}=require('../server/reactions');

function fixture(){
  let now=10000;const sent=[];
  const players=[{id:'a',name:'甲',seated:true},{id:'b',name:'乙',seated:true},{id:'c',name:'观众',seated:false}];
  const room={code:'123456',updated:0,deadline:55000,finished:false,game:{players,events:['原有记录'],phase:'preflop',turnId:'a'}};
  const sessions=new Map(players.map(p=>[p.id,{id:p.id,room:room.code,expiresAt:100000,ws:{readyState:1,id:p.id}}]));
  const reactions=new RoomReactions({sessions,send:(ws,event)=>sent.push({ws,event}),clock:()=>now});
  return {room,sessions,sent,reactions,setTime:value=>{now=value;},a:sessions.get('a'),b:sessions.get('b'),c:sessions.get('c')};
}

test('表情以真实身份广播给同房在线成员和观众，不改变牌局与回合',()=>{
  const f=fixture(),before=structuredClone(f.room.game),deadline=f.room.deadline;
  f.room.game.players.push({id:'left',name:'已离开',pendingRemove:true},{id:'other',name:'其他房间'},{id:'offline',name:'离线'},{id:'expired',name:'过期'});
  f.sessions.set('left',{id:'left',room:f.room.code,expiresAt:100000,ws:{readyState:1}});
  f.sessions.set('other',{id:'other',room:'654321',expiresAt:100000,ws:{readyState:1}});
  f.sessions.set('offline',{id:'offline',room:f.room.code,expiresAt:100000,ws:{readyState:3}});
  f.sessions.set('expired',{id:'expired',room:f.room.code,expiresAt:9000,ws:{readyState:1}});
  const event=f.reactions.react(f.room,f.c,{emoji:'like',to:'a',from:'b',fromName:'伪造',toName:'伪造',room:'wrong',id:'forged'});
  assert.match(event.id,/^[a-f0-9-]{36}$/);assert.notEqual(event.id,'forged');
  assert.deepEqual(event,{type:'reaction',id:event.id,room:'123456',from:'c',to:'a',emoji:'like',fromName:'观众',toName:'甲'});
  assert.deepEqual(f.sent.map(x=>x.ws.id),['a','b','c']);assert.ok(f.sent.every(x=>x.event===event));
  assert.equal(f.room.updated,10000);assert.equal(f.room.deadline,deadline);
  assert.deepEqual({...f.room.game,players:f.room.game.players.slice(0,3)},before);
});

test('非法表情、自己、离线和跨房目标会拒绝且不占冷却，失效身份不能发送',()=>{
  const f=fixture();
  for(const message of [{emoji:'unknown',to:'b'},{emoji:'__proto__',to:'b'},{emoji:'like',to:'a'},{emoji:'like',to:'missing'},{emoji:'like',to:null},{emoji:{},to:'b'}]){
    assert.throws(()=>f.reactions.react(f.room,f.a,message));assert.equal(f.a.reactionReadyAt,undefined);
  }
  f.b.ws.readyState=3;assert.throws(()=>f.reactions.react(f.room,f.a,{emoji:'like',to:'b'}),/离线/);
  f.b.ws.readyState=1;f.b.room='654321';assert.throws(()=>f.reactions.react(f.room,f.a,{emoji:'like',to:'b'}),/离线/);
  f.b.room=f.room.code;f.room.game.players[1].pendingRemove=true;assert.throws(()=>f.reactions.react(f.room,f.a,{emoji:'like',to:'b'}),/离线/);
  delete f.room.game.players[1].pendingRemove;
  assert.throws(()=>f.reactions.react(null,f.a,{emoji:'like',to:'b'}),/加入房间/);
  assert.throws(()=>f.reactions.react(f.room,{...f.a},{emoji:'like',to:'b'}),/重新加入/);
  f.a.room='654321';assert.throws(()=>f.reactions.react(f.room,f.a,{emoji:'like',to:'b'}),/重新加入/);f.a.room=f.room.code;
  assert.equal(f.sent.length,0);assert.equal(f.a.reactionReadyAt,undefined);
  f.reactions.react(f.room,f.a,{emoji:'handshake',to:'b'});assert.equal(f.sent.length,3);
});

test('表情冷却按身份保留，重连不能绕过，满两秒可再发，结束后仍能交流',()=>{
  const f=fixture();f.reactions.react(f.room,f.a,{emoji:'laugh',to:'b'});
  f.setTime(11000);f.a.ws={readyState:1,id:'reconnected'};
  assert.throws(()=>f.reactions.react(f.room,f.a,{emoji:'party',to:'b'}),error=>error.retryAfterMs===1000);
  assert.equal(f.sent.length,3);
  f.reactions.react(f.room,f.b,{emoji:'think',to:'c'});assert.equal(f.sent.length,6);
  f.setTime(10000+REACTION_COOLDOWN_MS);f.room.finished=true;
  const event=f.reactions.react(f.room,f.a,{emoji:'party',to:'b'});assert.equal(event.emoji,'party');assert.equal(f.sent.length,9);
  assert.equal(f.sent[6].ws,f.a.ws);assert.equal(f.a.reactionReadyAt,14000);
});
