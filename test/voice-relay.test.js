const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');

async function setup(){
  let clock=0,id=0;const timers=new Map(),sent=[],processors=[],nodes=[];
  const node=()=>{const n={disconnected:false,connect(){},disconnect(){this.disconnected=true;}};nodes.push(n);return n;};
  const context={state:'running',get currentTime(){return clock/1000;},audioWorklet:{async addModule(){}},createMediaStreamSource:node,createGain(){return {...node(),gain:{value:1}};},destination:{},async close(){this.state='closed';}};
  const globals={module:{exports:{}},ArrayBuffer,performance:{now:()=>clock},btoa,setTimeout(fn,ms){timers.set(++id,{fn,at:clock+ms});return id;},clearTimeout(key){timers.delete(key);},AudioWorkletNode:class{constructor(context,name,options){assert.equal(options?.processorOptions?.frameMetadata,true);Object.assign(this,node());this.port={onmessage:null,close(){this.closed=true;}};processors.push(this);}}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../web/voice-relay'),'utf8'),globals);
  const relay=new globals.module.exports.VoiceRelay({send:message=>sent.push({at:clock,sample:Buffer.from(message.data,'base64')[0],message})});
  relay.context=context;relay.ready=async()=>{};await relay.start({});
  const advance=to=>{for(;;){const entry=[...timers].filter(([,v])=>v.at<=to).sort((a,b)=>a[1].at-b[1].at)[0];if(!entry)break;timers.delete(entry[0]);clock=Math.max(clock,entry[1].at);entry[1].fn();}clock=to;};
  const emit=(sequence,capturedAt=clock/1000,sample=sequence%256)=>processors.at(-1).port.onmessage?.({data:{sequence,capturedAt,buffer:new Uint8Array(1920).fill(sample).buffer}});
  return {relay,sent,timers,processors,nodes,advance,emit,jump:to=>{clock=to;}};
}

test('语音正常以 60ms 一帧发送，不额外增加延迟或改变音频内容',async()=>{
  const h=await setup();for(let i=0;i<100;i++){h.advance(i*60);h.emit(i);}
  assert.equal(h.sent.length,100);assert.equal(h.timers.size,0);
  for(let i=0;i<100;i++){assert.equal(h.sent[i].at,i*60);assert.equal(h.sent[i].sample,i);assert.equal(Buffer.from(h.sent[i].message.data,'base64').length,1920);}
});

test('主线程恢复后的积压帧丢弃，突发最多保留最新一帧并按 60ms 发送',async()=>{
  const h=await setup();h.emit(0);h.jump(6000);
  for(let i=1;i<=100;i++)h.emit(i,i*.06);
  assert.equal(h.sent.length,2);assert.equal(h.timers.size,1);
  assert.ok(h.sent[1].sample>=97);h.advance(6060);
  assert.equal(h.sent.length,3);assert.equal(h.sent[2].sample,100);assert.equal(h.sent[2].at-h.sent[1].at,60);
  h.advance(9000);assert.equal(h.sent.length,3);assert.equal(h.timers.size,0);
});

test('过期、重复和逆序采集帧不发送，挂起的定时器不补发旧语音',async()=>{
  const h=await setup();h.emit(0);h.advance(10);h.emit(1);
  h.jump(2000);h.advance(2000);assert.equal(h.sent.length,1);
  h.emit(2,.1);h.emit(3,2,73);assert.equal(h.sent.length,2);assert.equal(h.sent[1].sample,73);
  h.emit(3,2,74);h.emit(2,2,75);h.advance(2060);assert.equal(h.sent.length,2);
});

test('闭麦和退出清除待发送音频，旧采集回调无法影响重新开麦',async()=>{
  const h=await setup();h.emit(0);h.advance(10);h.emit(1);
  const oldCallback=h.processors[0].port.onmessage;h.relay.stopCapture();assert.equal(h.timers.size,0);assert.equal(h.processors[0].port.closed,true);
  oldCallback({data:{sequence:2,capturedAt:.01,buffer:new ArrayBuffer(1920)}});h.advance(60);assert.equal(h.sent.length,1);
  await h.relay.start({});h.emit(0,.06,9);assert.equal(h.sent.length,2);assert.equal(h.sent[1].sample,9);
  h.advance(70);h.emit(1);h.relay.close();h.advance(130);assert.equal(h.sent.length,2);assert.equal(h.timers.size,0);
});

test('重复开麦与加载采集模块期间闭麦只保留当前采集，不启动旧采集',async()=>{
  const h=await setup();const loading=[];h.relay.context.audioWorklet.addModule=()=>new Promise(resolve=>loading.push(resolve));
  const settle=()=>new Promise(resolve=>setImmediate(resolve));
  const first=h.relay.start({});await settle();const second=h.relay.start({});await settle();
  loading[0]();await first;assert.equal(h.processors.length,1);loading[1]();await second;assert.equal(h.processors.length,2);
  const third=h.relay.start({});await settle();h.relay.stopCapture();loading[2]();await third;assert.equal(h.processors.length,2);assert.equal(h.relay.capture,null);
});
