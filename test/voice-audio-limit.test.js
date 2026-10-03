const test=require('node:test'),assert=require('node:assert/strict');
const {VoiceAudioLimit}=require('../server/voice-audio-limit');

test('正常60ms语音帧持续一分钟，不被固定秒边界误限流',()=>{
  let now=0;const limit=new VoiceAudioLimit({clock:()=>now});
  for(let i=0;i<1000;i++){now=i*60;assert.equal(limit.allow(),true);}
});

test('网络聚集的语音允许短突发，超量丢包后会自动恢复',()=>{
  let now=0;const limit=new VoiceAudioLimit({clock:()=>now});
  for(let i=0;i<40;i++)assert.equal(limit.allow(),true);
  for(let i=0;i<500;i++)assert.equal(limit.allow(),false);
  now=49;assert.equal(limit.allow(),false);
  now=50;assert.equal(limit.allow(),true);
  assert.equal(limit.allow(),false);
  now=1050;for(let i=0;i<20;i++)assert.equal(limit.allow(),true);
  assert.equal(limit.allow(),false);
});

test('长时间静音不会积累无限发送额度，每个连接独立限制',()=>{
  let now=0;const a=new VoiceAudioLimit({clock:()=>now}),b=new VoiceAudioLimit({clock:()=>now});
  for(let i=0;i<40;i++)a.allow();assert.equal(a.allow(),false);assert.equal(b.allow(),true);
  now=3600000;for(let i=0;i<40;i++)assert.equal(a.allow(),true);
  assert.equal(a.allow(),false);
  now-=500;assert.equal(a.allow(),false);
});
