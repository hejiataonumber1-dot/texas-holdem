const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const {createWechatExchange,SessionStore}=require('../server/wechat-auth');

test('微信凭证在服务端交换，客户端数据不决定 OpenID',async()=>{
  let requested;
  const exchange=createWechatExchange({appid:'wx-test',secret:'server-secret',fetchFn:async url=>{requested=url;return {ok:true,json:async()=>({openid:'verified-user',session_key:'private-key'})};}});
  assert.equal(await exchange('login-code'),'verified-user');
  assert.equal(requested.origin,'https://api.weixin.qq.com');assert.equal(requested.searchParams.get('js_code'),'login-code');assert.equal(requested.searchParams.get('secret'),'server-secret');
  await assert.rejects(exchange('invalid code'),/凭证无效/);
});
test('未配置、失效 code、上游错误及非法响应不能登录',async()=>{
  await assert.rejects(createWechatExchange({})('code'),e=>e.status===503);
  const fake=body=>createWechatExchange({appid:'app',secret:'secret',fetchFn:async()=>({ok:true,json:async()=>body})});
  await assert.rejects(fake({errcode:40029,errmsg:'provider-secret'})('code'),e=>e.status===401&&!e.message.includes('provider-secret'));
  await assert.rejects(fake(null)('code'),e=>e.status===502);
  await assert.rejects(fake({session_key:'only-key'})('code'),e=>e.status===502);
  await assert.rejects(createWechatExchange({appid:'app',secret:'secret',fetchFn:async()=>{throw Error('secret-url');}})('code'),e=>e.status===502&&!e.message.includes('secret-url'));
});
test('同一 OpenID 恢复座位并更换令牌，不同微信身份隔离',()=>{
  let now=0;const store=new SessionStore({clock:()=>now,ttl:100});
  const a=store.wechat('openid-a','A'),firstToken=a.token;a.room='123456';
  const again=store.wechat('openid-a','新昵称');assert.equal(again.id,a.id);assert.equal(again.room,'123456');assert.equal(again.name,'A');
  assert.notEqual(again.token,firstToken);assert.equal(store.fromToken(firstToken),null);assert.equal(store.fromToken(again.token),a);
  const b=store.wechat('openid-b','B');assert.notEqual(a.id,b.id);assert.equal(b.room,null);
  now=100;assert.equal(store.fromToken(a.token),null);store.remove(a);assert.equal(store.wechatUsers.has('openid-a'),false);
});
function loadClient(wx){const exported={exports:{}};vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'../miniprogram/auth.js'),'utf8'),{wx,module:exported,require:()=>({apiBaseUrl:'https://game.test'})});return exported.exports;}
test('小程序调用 wx.login 后 POST code，并只保存业务令牌',async()=>{
  const stored=new Map();let request;
  const auth=loadClient({login(options){options.success({code:'wx-code'});},request(options){request=options;options.success({statusCode:200,data:{token:'business-token'}});},setStorageSync:(k,v)=>stored.set(k,v)});
  assert.equal(await auth.login('朋友'),'business-token');assert.equal(request.url,'https://game.test/api/auth/wechat');assert.equal(request.data.code,'wx-code');assert.equal(request.data.name,'朋友');assert.equal(request.method,'POST');assert.equal(stored.get(auth.TOKEN_KEY),'business-token');assert.equal(JSON.stringify(request.data).includes('secret'),false);
});
test('微信登录失败或后端拒绝时，小程序不保存成功身份',async()=>{
  const auth=loadClient({login:o=>o.success({code:'code'}),request:o=>o.success({statusCode:503,data:{message:'服务端未配置'}}),setStorageSync(){assert.fail('失败不能保存令牌');}});
  await assert.rejects(auth.login('朋友'),/服务端未配置/);
  const noCode=loadClient({login:o=>o.success({}),request(){assert.fail('无 code 不能调用后端');}});await assert.rejects(noCode.login('朋友'),/凭证失败/);
});
