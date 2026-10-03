class VoiceChat {
  constructor({root,getState,send,notice,getMedia}){
    this.$=id=>root.querySelector('#'+id);this.getState=getState;this.send=send;this.notice=notice;this.customMedia=!!getMedia;this.getMedia=getMedia||(()=>navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false}));
    this.connections=new Map();this.roster=[];this.stream=null;this.joined=false;this.joining=false;this.listening=true;this.micOn=false;this.micBusy=false;this.generation=0;this.micGeneration=0;
    this.$('voice-join').onclick=()=>this.join();this.$('voice-mic').onclick=()=>this.microphone();this.$('voice-listen').onclick=()=>this.hearing();this.$('voice-leave').onclick=()=>this.leave();this.$('voice-play').onclick=()=>this.play();this.render();
  }
  join(){
    if(this.joined||this.joining)return;
    if(!this.getState())return;
    if(typeof RTCPeerConnection==='undefined'&&typeof VoiceRelay==='undefined'){this.notice('当前浏览器不支持语音，请换用系统浏览器');return;}
    if(typeof VoiceRelay!=='undefined'){this.relay=new VoiceRelay({send:this.send,notice:this.notice});this.relay.ready().catch(()=>this.blocked());}
    this.generation++;this.joining=true;this.listening=true;this.send({type:'voice-join',relaySupported:typeof VoiceRelay!=='undefined'});
    this.joinTimer=setTimeout(()=>{if(this.joining){this.leave();this.notice('加入语音超时，请重新加入');}},10000);this.render();
  }
  async microphone(){
    if(!this.joined)return;
    if(this.micOn||this.micBusy){this.stopMic();this.send({type:'voice-mute',muted:true});this.render();return;}
    if(!this.customMedia&&!navigator.mediaDevices?.getUserMedia){this.notice('麦克风需要 HTTPS 和浏览器支持');return;}
    const generation=this.generation,micGeneration=++this.micGeneration;this.micBusy=true;this.render();
    try{
      const stream=await this.getMedia();
      if(!this.joined||generation!==this.generation||micGeneration!==this.micGeneration){stream.getTracks().forEach(t=>t.stop());return;}
      this.stream=stream;this.micOn=true;this.micBusy=false;
      const track=stream.getAudioTracks()[0];if(!track)throw Error('没有可用的麦克风');
      track.onended=()=>{if(this.micOn){this.stopMic();if(this.joined)this.send({type:'voice-mute',muted:true});this.render();}};
      if(this.transport==='relay')await this.relay.start(stream);
      await Promise.all([...this.connections.values()].map(async p=>{await p.sender.replaceTrack(track);p.sender.setStreams(stream);}));
      if(this.joined&&generation===this.generation&&micGeneration===this.micGeneration)this.send({type:'voice-mute',muted:false});
    }catch(error){if(generation===this.generation&&micGeneration===this.micGeneration){this.stopMic();this.notice(error.name==='NotAllowedError'?'麦克风未获授权，仍可只听声音':error.name==='NotFoundError'?'没有检测到麦克风，仍可只听声音':'麦克风打开失败，请检查浏览器权限');this.render();}}
    finally{if(generation===this.generation&&micGeneration===this.micGeneration){this.micBusy=false;this.render();}}
  }
  stopMic(){this.relay?.stopCapture();this.micGeneration++;this.micOn=false;this.micBusy=false;for(const p of this.connections.values())p.sender.replaceTrack(null).then(()=>p.sender.setStreams()).catch(()=>{});this.stream?.getTracks().forEach(t=>t.stop());this.stream=null;}
  hearing(){this.listening=!this.listening;this.relay?.hearing(this.listening).catch(()=>this.blocked());for(const p of this.connections.values()){p.audio.muted=!this.listening;if(this.listening)p.audio.play().catch(()=>this.blocked());}this.render();}
  blocked(){this.$('voice-play').hidden=false;}
  play(){if(this.relay&&this.listening)this.relay.ready().catch(()=>this.blocked());for(const p of this.connections.values())if(this.listening)p.audio.play().catch(()=>this.notice('播放被浏览器阻止，请再次点击开启收听'));this.$('voice-play').hidden=true;}
  peer(peerId){
    let p=this.connections.get(peerId);if(p)return p;
    const pc=new RTCPeerConnection({iceServers:this.iceServers||[]}),audio=document.createElement('audio');audio.autoplay=true;audio.setAttribute('playsinline','');audio.muted=!this.listening;this.$('voice-audio').append(audio);
    const sender=pc.addTransceiver('audio',{direction:'sendrecv'}).sender;
    p={pc,audio,sender,candidates:[],chain:Promise.resolve(),status:'连接中',polite:this.peerId.localeCompare(peerId)>0,makingOffer:false,ignoreOffer:false,settingRemoteAnswerPending:false};this.connections.set(peerId,p);
    pc.onnegotiationneeded=async()=>{try{p.makingOffer=true;await pc.setLocalDescription();if(this.joined&&this.connections.get(peerId)===p)this.send({type:'voice-signal',to:peerId,data:{kind:'description',description:{type:pc.localDescription.type,sdp:pc.localDescription.sdp}}});}catch{if(this.connections.get(peerId)===p){p.status='连接失败，请重新加入';this.render();}}finally{p.makingOffer=false;}};
    if(this.stream){const stream=this.stream;sender.replaceTrack(stream.getAudioTracks()[0]).then(()=>sender.setStreams(stream)).catch(()=>{});}
    pc.onicecandidate=e=>{if(e.candidate&&this.joined&&this.connections.get(peerId)===p)this.send({type:'voice-signal',to:peerId,data:{kind:'candidate',candidate:e.candidate.toJSON()}});};
    pc.ontrack=e=>{audio.srcObject=e.streams[0]||new MediaStream([e.track]);if(this.listening)audio.play().catch(()=>this.blocked());};
    pc.onconnectionstatechange=()=>{if(this.connections.get(peerId)!==p)return;p.status=pc.connectionState==='connected'?'已连接':['failed','disconnected'].includes(pc.connectionState)?'连接中断':'连接中';this.render();};
    p.timer=setTimeout(()=>{if(this.connections.get(peerId)===p&&pc.connectionState!=='connected'){p.status='连接失败，请退出语音后重试';this.render();}},20000);
    return p;
  }
  closePeer(peerId){const p=this.connections.get(peerId);if(!p)return;this.connections.delete(peerId);clearTimeout(p.timer);p.pc.close();p.audio.srcObject=null;p.audio.remove();}
  async handle(message){
    if(message.type==='voice-joined'){
      if(!this.joining){this.send({type:'voice-leave'});return;}
      clearTimeout(this.joinTimer);this.joining=false;this.joined=true;this.iceServers=message.iceServers;this.transport=message.transport||'webrtc';this.roster=message.peers;
      const me=this.roster.find(p=>p.id===this.getState()?.you);this.peerId=me?.peerId;this.render();
      if(this.transport!=='relay')for(const member of this.roster)if(member.peerId!==this.peerId)this.peer(member.peerId);
    }else if(message.type==='voice-audio'){
      if(this.joined&&this.transport==='relay'&&message.from!==this.peerId&&this.roster.some(p=>p.peerId===message.from))this.relay.receive(message.from,message.data);
    }else if(message.type==='voice-roster'){
      if(this.transport==='relay')for(const member of this.roster)if(!message.peers.some(p=>p.peerId===member.peerId&&!p.muted))this.relay?.flush(member.peerId);
      this.roster=message.peers;if(this.joined&&!this.roster.some(p=>p.peerId===this.peerId)){this.leave(false);return;}
      for(const id of this.connections.keys())if(!this.roster.some(p=>p.peerId===id))this.closePeer(id);this.render();
    }else if(message.type==='voice-signal'){
      if(this.transport==='relay'||!this.joined||!this.roster.some(p=>p.peerId===message.from))return;
      const p=this.peer(message.from),data=message.data;
      p.chain=p.chain.then(async()=>{
        if(!this.joined||this.connections.get(message.from)!==p)return;
        if(data.kind==='description'){
          const ready=!p.makingOffer&&(p.pc.signalingState==='stable'||p.settingRemoteAnswerPending),collision=data.description.type==='offer'&&!ready;p.ignoreOffer=!p.polite&&collision;if(p.ignoreOffer)return;
          p.settingRemoteAnswerPending=data.description.type==='answer';await p.pc.setRemoteDescription(data.description);p.settingRemoteAnswerPending=false;for(const candidate of p.candidates)await p.pc.addIceCandidate(candidate);p.candidates=[];
          if(data.description.type==='offer'){await p.pc.setLocalDescription(await p.pc.createAnswer());if(this.joined&&this.connections.get(message.from)===p)this.send({type:'voice-signal',to:message.from,data:{kind:'description',description:{type:p.pc.localDescription.type,sdp:p.pc.localDescription.sdp}}});}
        }else if(data.kind==='candidate'){if(p.ignoreOffer)return;if(p.pc.remoteDescription)await p.pc.addIceCandidate(data.candidate);else if(p.candidates.length<100)p.candidates.push(data.candidate);}
      }).catch(()=>{p.status='连接失败，请重新加入';this.render();});
    }else if(message.type==='voice-left')return;
    else if(message.type==='voice-error'){if(message.operation==='voice-join')this.leave(false);this.notice(message.message);}
  }
  update(peers){this.roster=peers||[];this.render();}
  leave(notify=true){if(notify&&(this.joined||this.joining))this.send({type:'voice-leave'});clearTimeout(this.joinTimer);this.generation++;this.joined=false;this.joining=false;this.stopMic();this.relay?.close();this.relay=null;for(const id of [...this.connections.keys()])this.closePeer(id);this.$('voice-play').hidden=true;this.render();}
  render(){
    this.$('voice-join').hidden=this.joined;this.$('voice-join').disabled=this.joining;this.$('voice-join').textContent=this.joining?'正在加入…':'加入语音 · 默认只听';
    for(const id of ['voice-mic','voice-listen','voice-leave'])this.$(id).hidden=!this.joined;
    this.$('voice-mic').textContent=this.micBusy?'取消开麦':this.micOn?'闭麦':'开麦';this.$('voice-mic').setAttribute('aria-pressed',String(this.micOn));
    this.$('voice-listen').textContent=this.listening?'关闭收听':'开启收听';this.$('voice-listen').setAttribute('aria-pressed',String(this.listening));
    this.$('voice-status').textContent=this.joined?`${this.micOn?'麦克风开启':'麦克风关闭'} · ${this.listening?'正在收听':'收听关闭'} · ${this.roster.length} 人在线`:'尚未加入语音，麦克风关闭';
    this.$('voice-members').replaceChildren();for(const member of this.roster){const span=document.createElement('span');span.className='voice-person';const isMe=member.id===this.getState()?.you;span.textContent=`${member.name}${isMe?' · 你':''} · ${member.muted?'闭麦':'开麦'}${!isMe&&this.joined?' · '+(this.transport==='relay'?'服务器转发':this.connections.get(member.peerId)?.status||'连接中'):''}`;this.$('voice-members').append(span);}
  }
}
if(typeof module!=='undefined')module.exports={VoiceChat};
