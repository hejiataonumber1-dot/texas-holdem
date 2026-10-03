const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {AdminAccess}=require('../server/admin-access');
function setup(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'poker-admin-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const options={username:'admin-test',password:'password-test-42',file:path.join(dir,'access.json')};return {options,admin:new AdminAccess(options)};}

test('新实例默认自由建房，同一来源十五分钟最多五次，第六次拒绝',t=>{
  const {admin}=setup(t);assert.equal(admin.requireCode,false);assert.equal(admin.status().requireCode,false);
  for(let i=0;i<5;i++)assert.doesNotThrow(()=>admin.consume(undefined,'same-ip'));
  assert.equal(admin.status().used,0);assert.throws(()=>admin.consume('', 'same-ip'),/15 分钟/);
  assert.doesNotThrow(()=>admin.consume('', 'another-ip'));
  const future=Date.now()+15*60*1000;admin.now=()=>future;assert.doesNotThrow(()=>admin.consume('', 'same-ip'));
});
test('自由创建开关持久化，恢复授权模式后仍需有效码，旧存储兼容',t=>{
  const {admin,options}=setup(t);admin.setCode({code:'test-valid-code'});const legacy=admin.code;assert.equal(admin.requireCode,false);
  admin.consume('', 'public-ip');assert.equal(admin.status().used,0);
  const restored=new AdminAccess({...options,initialCode:'must-not-override'});assert.equal(restored.requireCode,false);restored.consume(undefined,'new-ip');
  restored.setPolicy({requireCode:true});assert.throws(()=>restored.consume('', 'new-ip'),/授权码/);restored.consume('test-valid-code','new-ip');
  assert.equal(new AdminAccess(options).requireCode,true);
  restored.setCode({code:'replacement-code'});assert.equal(restored.requireCode,true);assert.throws(()=>restored.consume('test-valid-code','old-code'),/授权码/);
  restored.setPolicy({requireCode:false});assert.doesNotThrow(()=>restored.consume('', 'new-ip'));assert.equal(new AdminAccess(options).requireCode,false);
  restored.setCode({enabled:false});assert.equal(restored.requireCode,false);assert.doesNotThrow(()=>restored.consume('', 'new-ip'));
  assert.throws(()=>restored.setPolicy({requireCode:'false'}));
  fs.writeFileSync(options.file,JSON.stringify(legacy));const migrated=new AdminAccess(options);assert.equal(migrated.requireCode,true);assert.throws(()=>migrated.consume('', 'legacy-ip'),/授权码/);assert.doesNotThrow(()=>migrated.consume('test-valid-code','legacy-ip'));
});
test('显式配置初始授权码启用授权模式，保存过的自由或授权策略优先',t=>{
  const {options}=setup(t),admin=new AdminAccess({...options,initialCode:'configured-code'});
  assert.equal(admin.requireCode,true);assert.throws(()=>admin.consume('', 'configured-ip'),/授权码/);admin.consume('configured-code','configured-ip');
  assert.equal(new AdminAccess({...options,initialCode:'different-code'}).requireCode,true);
  admin.setPolicy({requireCode:false});const restored=new AdminAccess({...options,initialCode:'different-code'});assert.equal(restored.requireCode,false);assert.doesNotThrow(()=>restored.consume('', 'free-ip'));
  restored.setPolicy({requireCode:true});assert.doesNotThrow(()=>restored.consume('configured-code','configured-ip'));assert.throws(()=>restored.consume('different-code','different-ip'),/授权码/);
});
test('授权码必须有效，有次数和有效期限制，更换或停用后旧码不能建房',t=>{
  const {options,admin}=setup(t);admin.setPolicy({requireCode:true});assert.throws(()=>admin.consume('', 'first'),/授权码/);
  admin.setCode({code:'private-code-42',maxUses:2,days:1});assert.equal(admin.status().remaining,2);
  admin.consume('private-code-42','first');assert.equal(admin.status().used,1);
  const restored=new AdminAccess(options);assert.equal(restored.status().used,1);restored.consume('private-code-42','first');assert.throws(()=>restored.consume('private-code-42','first'),/授权码/);
  restored.setCode({code:'changed-code-42'});assert.throws(()=>restored.consume('private-code-42','old'),/授权码/);restored.consume('changed-code-42','new');
  restored.setCode({enabled:false});assert.throws(()=>restored.consume('changed-code-42','new'),/授权码/);assert.equal(new AdminAccess(options).status().enabled,false);
  restored.setCode({code:'expired-code-42',days:1});restored.now=()=>Date.now()+2*24*60*60*1000;assert.throws(()=>restored.consume('expired-code-42','expired'),/授权码/);
  const stored=fs.readFileSync(options.file,'utf8');assert.equal(stored.includes('expired-code-42'),false);assert.equal(stored.includes(options.password),false);
});
test('管理员登录、退出、会话过期，跨连接猜授权码和密码受到限制',t=>{
  const {admin}=setup(t);const token=admin.login('admin-test','password-test-42','admin-ip');assert.equal(admin.authenticated(token),true);admin.logout(token);assert.equal(admin.authenticated(token),false);
  const expiring=admin.login('admin-test','password-test-42','admin-ip');const future=Date.now()+9*60*60*1000;admin.now=()=>future;assert.equal(admin.authenticated(expiring),false);
  for(let i=0;i<5;i++)assert.throws(()=>admin.login('admin-test','wrong','attacker'),/账号或密码/);
  assert.throws(()=>admin.login('admin-test','password-test-42','attacker'),/15 分钟/);
  admin.setPolicy({requireCode:true});admin.setCode({code:'private-code-42'});for(let i=0;i<5;i++)assert.throws(()=>admin.consume('wrong-code','attacker'),/授权码/);assert.throws(()=>admin.consume('private-code-42','attacker'),/15 分钟/);
});
test('没有配置管理员默认自由建房，但管理员登录不可用，初始码不会启用授权',t=>{
  const {options}=setup(t),admin=new AdminAccess({...options,password:undefined,initialCode:'unused-initial-code'});assert.equal(admin.requireCode,false);assert.equal(admin.status().configured,false);assert.equal(admin.status().enabled,false);
  assert.throws(()=>admin.login('admin-test','password-test-42','ip'),/尚未配置/);assert.doesNotThrow(()=>admin.consume(undefined,'ip'));
  for(let i=1;i<5;i++)assert.doesNotThrow(()=>admin.consume('', 'ip'));assert.throws(()=>admin.consume('', 'ip'),/15 分钟/);
});
