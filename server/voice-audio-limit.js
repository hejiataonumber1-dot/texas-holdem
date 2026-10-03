const {performance}=require('node:perf_hooks');

// A 60 ms audio frame normally arrives about 17 times per second. Allow brief
// network batches without letting a sender flood the other room members.
class VoiceAudioLimit {
  constructor({clock=()=>performance.now()}={}) {
    this.clock=clock;this.updated=clock();this.tokens=40;
  }
  allow() {
    const now=Math.max(this.updated,this.clock());
    this.tokens=Math.min(40,this.tokens+(now-this.updated)*20/1000);
    this.updated=now;
    if(this.tokens<1)return false;
    this.tokens--;return true;
  }
}
module.exports={VoiceAudioLimit};
