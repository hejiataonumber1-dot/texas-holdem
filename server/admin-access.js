const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
function hash(secret,salt){return crypto.scryptSync(secret,salt,32);}
function protection(secret){const salt=crypto.randomBytes(16).toString('base64');return {salt,hash:hash(secret,salt).toString('base64')};}
function matches(value,stored){return typeof value==='string'&&value.length<=128&&crypto.timingSafeEqual(hash(value,stored.salt),Buffer.from(stored.hash,'base64'));}
class AdminAccess {
  constructor({username,password,file,now=Date.now,initialCode}){
    this.username=username;this.password=typeof password==='string'&&password.length>=6&&password.length<=128?protection(password):null;this.file=file;this.now=now;this.sessions=new Map();this.limits=new Map();this.code=null;this.requireCode=false;
    if(fs.existsSync(file)){const saved=JSON.parse(fs.readFileSync(file,'utf8'));this.requireCode=saved?.requireCode!==false;this.code=saved&&'requireCode' in saved?saved.code:saved;if(this.code&&(!this.code.salt||!this.code.hash||!Number.isSafeInteger(this.code.used)||!Number.isSafeInteger(this.code.maxUses)||!Number.isFinite(this.code.expiresAt)))throw Error('授权码记录无效，请管理员恢复备份');}
    else if(initialCode&&this.configured){this.requireCode=true;this.setCode({code:initialCode});}
  }
  get configured(){return !!(this.username&&this.password);}
  limit(kind,ip){const key=kind+':'+ip,now=this.now();for(const [k,v] of this.limits)if(now-v.since>=15*60*1000)this.limits.delete(k);let v=this.limits.get(key);if(!v){if(this.limits.size>=4096)throw Error('服务繁忙，请稍后重试');v={since:now,count:0};this.limits.set(key,v);}if(v.count>=5)throw Error('失败次数过多，请 15 分钟后再试');return v;}
  login(username,password,ip){
    if(!this.configured)throw Error('管理员尚未配置，请先设置服务器管理员账号和密码');
    const limit=this.limit('login',ip);if(username!==this.username||!matches(password,this.password)){limit.count++;throw Error('账号或密码不正确');}limit.count=0;
    for(const [key,expires] of this.sessions)if(expires<=this.now())this.sessions.delete(key);
    if(this.sessions.size>=100)throw Error('登录会话过多，请先退出其他设备');
    const token=crypto.randomBytes(32).toString('base64url');this.sessions.set(token,this.now()+8*60*60*1000);return token;
  }
  authenticated(token){const expires=this.sessions.get(token);if(!expires||expires<=this.now()){this.sessions.delete(token);return false;}return true;}
  logout(token){this.sessions.delete(token);}
  persist(code,requireCode=this.requireCode){fs.mkdirSync(path.dirname(this.file),{recursive:true});const temp=this.file+'.tmp';fs.writeFileSync(temp,JSON.stringify({requireCode,code}),{mode:0o600});fs.renameSync(temp,this.file);this.code=code;this.requireCode=requireCode;}
  setPolicy({requireCode}){if(typeof requireCode!=='boolean')throw Error('请选择创建房间的方式');this.persist(this.code,requireCode);return this.status();}
  setCode({code,days=7,maxUses=20,enabled=true}){
    if(enabled===false){if(this.code)this.persist({...this.code,enabled:false});return this.status();}
    if(!Number.isSafeInteger(days)||days<1||days>365)throw Error('有效期需要 1～365 天');
    if(!Number.isSafeInteger(maxUses)||maxUses<1||maxUses>1000)throw Error('建房次数需要 1～1,000 次');
    if(!code)code=crypto.randomBytes(16).toString('base64url');
    if(typeof code!=='string'||code.length<8||code.length>32||code.trim()!==code)throw Error('授权码需要 8～32 个字符，首尾不能有空格');
    this.persist({...protection(code),enabled:true,expiresAt:this.now()+days*24*60*60*1000,maxUses,used:0});
    return {...this.status(),code};
  }
  status(){const c=this.code;return {configured:this.configured,requireCode:this.requireCode,enabled:!!(c?.enabled&&c.expiresAt>this.now()&&c.used<c.maxUses),expiresAt:c?.expiresAt||null,maxUses:c?.maxUses||0,used:c?.used||0,remaining:c?Math.max(0,c.maxUses-c.used):0};}
  consume(value,ip){
    if(!this.requireCode){const limit=this.limit('open-create',ip);limit.count++;return;}
    const limit=this.limit('create',ip);
    if(!this.configured||!this.status().enabled||typeof value!=='string'||value.length<8||value.length>32||!matches(value,this.code)){limit.count++;throw Error('创建授权码无效、已停用或已用完，请向管理员索取');}
    this.persist({...this.code,used:this.code.used+1});limit.count=0;
  }
}
module.exports={AdminAccess};
