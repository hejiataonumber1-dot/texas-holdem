class PokerVoiceCapture extends AudioWorkletProcessor {
  constructor(options){super();this.phase=0;this.sum=0;this.count=0;this.frame=new Int16Array(960);this.offset=0;this.sequence=0;this.frameMetadata=options?.processorOptions?.frameMetadata===true;}
  process(inputs){const channels=inputs[0];if(!channels?.length)return true;
    for(let i=0;i<channels[0].length;i++){
      let sample=0;for(const c of channels)sample+=c[i]||0;sample/=channels.length;
      this.sum+=sample;this.count++;this.phase+=16000/sampleRate;
      if(this.phase>=1){this.phase-=1;const value=Math.max(-1,Math.min(1,this.sum/this.count));this.frame[this.offset++]=Math.round(value*32767);this.sum=0;this.count=0;
        if(this.offset===960){const buffer=this.frame.buffer,payload=this.frameMetadata?{buffer,sequence:this.sequence++,capturedAt:currentTime+(i+1)/sampleRate}:buffer;this.port.postMessage(payload,[buffer]);this.frame=new Int16Array(960);this.offset=0;}
      }
    }return true;
  }
}
registerProcessor('poker-voice-capture',PokerVoiceCapture);
