const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
test('语音采集在 44.1k/48k 采样率产生固定 16k PCM 帧，幅度与帧长受限',()=>{
 for(const rate of [44100,48000]){
  const frames=[];let Processor;const context={sampleRate:rate,currentTime:0,AudioWorkletProcessor:class{constructor(){this.port={postMessage:frame=>frames.push(frame)};}},registerProcessor:(_,p)=>Processor=p};
  vm.runInNewContext(fs.readFileSync(require.resolve('../web/voice-capture'),'utf8'),context);const p=new Processor({processorOptions:{frameMetadata:true}});
  const input=new Float32Array(128).fill(.5);for(let i=0;i<Math.ceil(rate/128);i++){context.currentTime=i*128/rate;p.process([[input]]);}
  assert.equal(frames.length,16);const samples=new Int16Array(frames[0].buffer);assert.equal(samples.length,960);assert.ok(Math.abs(samples[0]-16384)<=1);
  for(let i=0;i<frames.length;i++){assert.equal(frames[i].sequence,i);assert.ok(Math.abs(frames[i].capturedAt-(i+1)*.06)<1.01/rate);}
 }
});
test('旧页面未要求帧元数据时，采集器仍发送原始 ArrayBuffer',()=>{
 const frames=[];let Processor;const context={sampleRate:48000,currentTime:0,ArrayBuffer,Int16Array,AudioWorkletProcessor:class{constructor(){this.port={postMessage:frame=>frames.push(frame)};}},registerProcessor:(_,p)=>Processor=p};
 vm.runInNewContext(fs.readFileSync(require.resolve('../web/voice-capture'),'utf8'),context);const p=new Processor();
 const input=new Float32Array(128).fill(.5);for(let i=0;i<23;i++){context.currentTime=i*128/48000;p.process([[input]]);}
 assert.equal(frames.length,1);assert.ok(frames[0] instanceof ArrayBuffer);assert.equal(new Uint8Array(frames[0]).length,1920);assert.ok(Math.abs(new Int16Array(frames[0])[0]-16384)<=1);
});
