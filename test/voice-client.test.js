const test=require('node:test');
const assert=require('node:assert/strict');
const {VoiceChat}=require('../web/voice');
test('默认只听不申请麦克风，开闭麦和收听互不影响，取消权限等待后释放轨道',async t=>{
  const savedDoc=global.document,savedRtc=global.RTCPeerConnection;
  const node=()=>({hidden:false,disabled:false,textContent:'',children:[],setAttribute(){},append(c){this.children.push(c);},replaceChildren(){this.children=[];}}),nodes=new Map();
  global.document={createElement:node};global.RTCPeerConnection=function(){};t.after(()=>{global.document=savedDoc;global.RTCPeerConnection=savedRtc;});
  const sent=[],notices=[];let count=0,resolveMedia;
  const v=new VoiceChat({root:{querySelector(id){if(!nodes.has(id))nodes.set(id,node());return nodes.get(id);}},getState:()=>({you:'me'}),send:m=>sent.push(m),notice:m=>notices.push(m),getMedia:()=>{count++;return new Promise(r=>resolveMedia=r);}});
  v.join();assert.equal(count,0);await v.handle({type:'voice-joined',peers:[{id:'me',peerId:'self',name:'我',muted:true}],iceServers:[]});assert.equal(v.joined,true);assert.equal(v.micOn,false);
  v.hearing();assert.equal(v.listening,false);assert.equal(count,0);
  const track={readyState:'live',stop(){this.readyState='ended';}},stream={getTracks:()=>[track],getAudioTracks:()=>[track]};
  const permission=v.microphone();assert.equal(count,1);await v.microphone();resolveMedia(stream);await permission;assert.equal(track.readyState,'ended');assert.equal(v.micOn,false);assert.equal(v.listening,false);
  const liveTrack={readyState:'live',stop(){this.readyState='ended';}},live={getTracks:()=>[liveTrack],getAudioTracks:()=>[liveTrack]};const opening=v.microphone();resolveMedia(live);await opening;assert.equal(v.micOn,true);assert.equal(v.listening,false);
  v.hearing();assert.equal(v.listening,true);assert.equal(v.micOn,true);await v.microphone();assert.equal(v.micOn,false);assert.equal(liveTrack.readyState,'ended');assert.equal(v.listening,true);
  v.leave();v.join();await v.handle({type:'voice-left'});assert.equal(v.joining,true);v.leave(false);assert.equal(v.joined,false);assert.equal(v.stream,null);
  assert.ok(sent.some(m=>m.type==='voice-mute'&&!m.muted));assert.equal(notices.length,0);
});
