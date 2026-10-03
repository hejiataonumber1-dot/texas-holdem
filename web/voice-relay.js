class VoiceRelay {
  constructor({send,notice}){this.send=send;this.notice=notice;this.playing=new Map();this.clocks=new Map();this.receivedBytes=0;this.captureGeneration=0;this.captureTimer=null;this.pendingFrame=null;this.lastCaptureSentAt=-Infinity;this.lastCaptureSequence=-1;this.listening=true;}
  async ready(){
    if(!this.context||this.context.state==='closed'){this.context=new(window.AudioContext||window.webkitAudioContext)({latencyHint:'interactive'});this.output=this.context.createGain();this.output.connect(this.context.destination);this.output.gain.value=this.listening?1:0;}
    await this.context.resume();if(this.context.state!=='running')throw Error('请点击开启收听');
  }
  async start(stream){
    this.stopCapture();const generation=this.captureGeneration;await this.ready();if(generation!==this.captureGeneration)return;await this.context.audioWorklet.addModule('/voice-capture.js?v=web21');if(generation!==this.captureGeneration)return;
    const source=this.context.createMediaStreamSource(stream),processor=new AudioWorkletNode(this.context,'poker-voice-capture',{processorOptions:{frameMetadata:true}}),silence=this.context.createGain();silence.gain.value=0;
    processor.port.onmessage=e=>this.queueCapture(e.data,generation);
    source.connect(processor);processor.connect(silence);silence.connect(this.context.destination);this.capture={source,processor,silence};
  }
  freshCapture(frame){return this.context?.state==='running'&&this.context.currentTime-frame.capturedAt<=.18&&frame.capturedAt-this.context.currentTime<=.06;}
  queueCapture(frame,generation){
    if(generation!==this.captureGeneration||!frame||!Number.isSafeInteger(frame.sequence)||frame.sequence<=this.lastCaptureSequence||!Number.isFinite(frame.capturedAt)||!(frame.buffer instanceof ArrayBuffer)||frame.buffer.byteLength!==1920)return;
    this.lastCaptureSequence=frame.sequence;if(!this.freshCapture(frame))return;
    // Main-thread stalls can deliver many worklet messages together. Keep only
    // the newest frame and pace output; never replay a backlog of old speech.
    this.pendingFrame={...frame,receivedAt:performance.now()};
    if(this.captureTimer!==null)return;
    const wait=60-(performance.now()-this.lastCaptureSentAt);
    if(wait>0)this.captureTimer=setTimeout(()=>{this.captureTimer=null;this.sendCapture(generation);},wait);
    else this.sendCapture(generation);
  }
  sendCapture(generation){
    if(generation!==this.captureGeneration)return;
    const frame=this.pendingFrame;this.pendingFrame=null;
    if(!frame||!this.freshCapture(frame)||performance.now()-frame.receivedAt>180)return;
    this.lastCaptureSentAt=performance.now();const bytes=new Uint8Array(frame.buffer);let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);this.send({type:'voice-audio',data:btoa(binary)});
  }
  stopCapture(){this.captureGeneration++;if(this.captureTimer!==null)clearTimeout(this.captureTimer);this.captureTimer=null;this.pendingFrame=null;this.lastCaptureSentAt=-Infinity;this.lastCaptureSequence=-1;if(this.capture){this.capture.processor.port.onmessage=null;this.capture.processor.port.close();for(const n of Object.values(this.capture))n.disconnect();this.capture=null;}}
  async hearing(on){this.listening=on;this.flush();if(this.output)this.output.gain.value=on?1:0;if(on)await this.ready();}
  receive(peerId,encoded){
    if(!this.listening||!this.context||this.context.state!=='running')return false;
    const binary=atob(encoded);if(binary.length!==1920)return false;
    const data=new Uint8Array(1920);for(let i=0;i<1920;i++)data[i]=binary.charCodeAt(i);const view=new DataView(data.buffer),buffer=this.context.createBuffer(1,960,16000),samples=buffer.getChannelData(0);for(let i=0;i<960;i++)samples[i]=view.getInt16(i*2,true)/32768;
    const now=this.context.currentTime;let at=this.clocks.get(peerId)||0;if(at<now||at>now+.4){this.flush(peerId);at=now+.06;}
    const node=this.context.createBufferSource();node.buffer=buffer;node.connect(this.output);let active=this.playing.get(peerId);if(!active){active=new Set();this.playing.set(peerId,active);}active.add(node);node.onended=()=>{active.delete(node);node.disconnect();};node.start(at);this.clocks.set(peerId,at+.06);this.receivedBytes+=1920;return true;
  }
  flush(peerId){for(const [id,nodes] of this.playing){if(peerId!==undefined&&id!==peerId)continue;for(const node of nodes){node.onended=null;try{node.stop();}catch{}node.disconnect();}this.playing.delete(id);this.clocks.delete(id);}}
  close(){this.stopCapture();this.flush();if(this.context)this.context.close().catch(()=>{});this.context=null;}
}
if(typeof module!=='undefined')module.exports={VoiceRelay};
