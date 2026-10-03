const test=require('node:test'),assert=require('node:assert/strict');
const {PlayerMemory}=require('../web/player-memory');
function storage(values={}) {
  const data=new Map(Object.entries(values));
  return {getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value),removeItem:key=>data.delete(key)};
}

test('关闭旧标签页后，新页面恢复原身份，不保存房间密码或自动加入请求',()=>{
  const localStorage=storage();
  const first=new PlayerMemory({localStorage,sessionStorage:storage()});
  first.save({name:'朋友',token:'original-token',password:'secret',room:'123456',intent:{type:'create'}});
  const reopened=new PlayerMemory({localStorage,sessionStorage:storage()});
  assert.deepEqual(reopened.read(),{name:'朋友',token:'original-token'});
  assert.deepEqual(JSON.parse(localStorage.getItem('poker-player')),{name:'朋友',token:'original-token'});
});

test('升级时迁移旧标签页身份，并优先采用已经持久保存的新 token',()=>{
  const localStorage=storage(),legacy=storage({'poker-name':'老玩家','poker-token':'old-token'});
  const migrated=new PlayerMemory({localStorage,sessionStorage:legacy});
  assert.equal(migrated.read().token,'old-token');
  assert.equal(legacy.getItem('poker-token'),null);
  migrated.save({token:'rotated-token'});
  const staleTab=storage({'poker-name':'旧昵称','poker-token':'old-token'});
  assert.deepEqual(new PlayerMemory({localStorage,sessionStorage:staleTab}).read(),{name:'老玩家',token:'rotated-token'});
});

test('服务器轮换身份后，已打开页面下次连接采用新的 token',()=>{
  const localStorage=storage(),first=new PlayerMemory({localStorage,sessionStorage:storage()});
  first.save({name:'朋友',token:'first'});
  const second=new PlayerMemory({localStorage,sessionStorage:storage()});
  second.save({name:'恢复的昵称',token:'second'});
  assert.deepEqual(first.read(),{name:'恢复的昵称',token:'second'});
});

test('浏览器拒绝持久存储时使用标签页存储；全部不可用时仍能在页面内游戏',()=>{
  const tab=storage(),restricted={sessionStorage:tab,get localStorage(){throw Error('denied');}};
  const first=new PlayerMemory(restricted);first.save({name:'朋友',token:'tab-token'});
  assert.equal(new PlayerMemory(restricted).read().token,'tab-token');
  const memoryOnly=new PlayerMemory({get localStorage(){throw Error('denied');},get sessionStorage(){throw Error('denied');}});
  memoryOnly.save({name:'朋友',token:'memory-token'});
  assert.equal(memoryOnly.read().token,'memory-token');
});

test('存储写入失败不使用旧 token 覆盖刚收到的身份',()=>{
  const full=storage({'poker-player':JSON.stringify({name:'朋友',token:'old'})});
  full.setItem=()=>{throw Error('quota');};
  const identity=new PlayerMemory({localStorage:full,sessionStorage:full});
  identity.save({token:'new'});
  assert.equal(identity.read().token,'new');
});

test('损坏或无效的记录不会阻止首页加载，仍保留可用昵称',()=>{
  for(const value of ['not json','null','[]','{"name":42,"token":{}}']) {
    const identity=new PlayerMemory({localStorage:storage({'poker-player':value}),sessionStorage:storage()});
    assert.deepEqual(identity.read(),{name:'',token:null});
    identity.save({name:' 新玩家 '});
    assert.deepEqual(identity.read(),{name:'新玩家',token:null});
  }
});
