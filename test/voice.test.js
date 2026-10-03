const test=require('node:test');
const assert=require('node:assert/strict');
const {VoiceRooms}=require('../server/voice-room');

test('语音服务器转发仅发同房成员，闭麦、不在语音中和慢连接不会泄漏音频',()=>{
 const delivered=[],sessions=new Map(),voice=new VoiceRooms({sessions,send:(ws,data)=>delivered.push({ws,data}),iceServers:[],transport:'relay'});
 const room={game:{players:[]}},outside={game:{players:[]}};
 for(const id of ['a','b','c','other']){const s={id,name:id,ws:{bufferedAmount:id==='c'?70000:0}};sessions.set(id,s);(id==='other'?outside:room).game.players.push(s);voice.join(id==='other'?outside:room,s);}
 const data=Buffer.alloc(1920).toString('base64');delivered.length=0;voice.audio(room,sessions.get('a'),data);assert.equal(delivered.length,0);
 voice.mute(room,sessions.get('a'),false);delivered.length=0;voice.audio(room,sessions.get('a'),data);assert.equal(delivered.length,1);assert.equal(delivered[0].ws,sessions.get('b').ws);assert.equal(delivered[0].data.data,data);
 assert.throws(()=>voice.audio(room,sessions.get('other'),data),/加入语音/);assert.throws(()=>voice.audio(room,sessions.get('a'),'invalid'),/格式/);
 voice.leave(room,sessions.get('a'));assert.throws(()=>voice.audio(room,sessions.get('a'),data),/加入语音/);
});
test('语音成员限制、默认闭麦、信令只发同房间已加入者、退出清理',()=>{
 const messages=[],sessions=new Map(),voice=new VoiceRooms({sessions,send:(ws,data)=>messages.push({ws,data}),iceServers:[]});
 const room={game:{players:[]}},other={game:{players:[]}};
 for(let i=0;i<11;i++){const s={id:String(i),name:'玩家'+i,ws:'socket'+i};sessions.set(s.id,s);room.game.players.push(s);}
 for(let i=0;i<9;i++)voice.join(room,sessions.get(String(i)));
 assert.throws(()=>voice.join(room,sessions.get('9')),/最多 9 人/);assert.equal(voice.members(room).every(p=>p.muted),true);
 const [a,b]=voice.members(room);voice.mute(room,sessions.get(a.id),false);assert.equal(voice.members(room)[0].muted,false);
 messages.length=0;voice.signal(room,sessions.get(a.id),b.peerId,{kind:'description',description:{type:'offer',sdp:'audio-offer'}});assert.deepEqual(messages,[{ws:'socket1',data:{type:'voice-signal',from:a.peerId,data:{kind:'description',description:{type:'offer',sdp:'audio-offer'}}}}]);
 assert.throws(()=>voice.signal(room,sessions.get('9'),a.peerId,{kind:'candidate',candidate:{candidate:'abc'}}),/不存在/);
 voice.join(other,sessions.get('10'));assert.throws(()=>voice.signal(room,sessions.get(a.id),voice.members(other)[0].peerId,{kind:'description',description:{type:'offer',sdp:'x'}}),/不存在/);
 assert.throws(()=>voice.signal(room,sessions.get(a.id),b.peerId,{kind:'description',description:{type:'offer',sdp:'x'.repeat(12001)}}),/无效/);
 voice.leave(room,sessions.get(a.id));assert.equal(voice.members(room).length,8);voice.join(room,sessions.get(a.id));const rejoined=voice.members(room).find(p=>p.id===a.id);assert.notEqual(rejoined.peerId,a.peerId);
 assert.throws(()=>voice.signal(room,sessions.get(b.id),a.peerId,{kind:'description',description:{type:'offer',sdp:'stale'}}),/不存在/);
});
