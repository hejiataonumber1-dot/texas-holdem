const crypto=require('node:crypto');

class AuthError extends Error {
  constructor(message,status=401,code='WECHAT_LOGIN_FAILED'){super(message);this.status=status;this.code=code;}
}
function createWechatExchange({appid,secret,fetchFn=fetch}) {
  return async code=>{
    if(!appid||!secret)throw new AuthError('服务端尚未配置微信 AppID 和 AppSecret',503,'WECHAT_NOT_CONFIGURED');
    if(typeof code!=='string'||!/^[A-Za-z0-9_-]{1,256}$/.test(code))throw new AuthError('微信登录凭证无效',400);
    const url=new URL('https://api.weixin.qq.com/sns/jscode2session');
    url.search=new URLSearchParams({appid,secret,js_code:code,grant_type:'authorization_code'}).toString();
    let result;
    try {
      const response=await fetchFn(url,{signal:AbortSignal.timeout(10000)});
      if(!response.ok)throw Error('upstream');result=await response.json();
    } catch {throw new AuthError('暂时无法连接微信登录服务，请稍后重试',502);}
    if(!result||typeof result!=='object')throw new AuthError('微信登录返回无效，请稍后重试',502);
    if(result.errcode) {
      if(result.errcode===40029||result.errcode===40163)throw new AuthError('登录凭证已失效，请重新微信登录');
      if(result.errcode===45011)throw new AuthError('微信登录太频繁，请稍后重试',429);
      if(result.errcode===40013||result.errcode===40125)throw new AuthError('服务端微信配置有误，请检查 AppID 与 AppSecret',503,'WECHAT_CONFIG_INVALID');
      throw new AuthError('微信登录未成功，请稍后重试');
    }
    if(typeof result.openid!=='string'||!result.openid||result.openid.length>128)throw new AuthError('微信登录返回无效，请稍后重试',502);
    // Only use the identity confirmed by WeChat. Do not send session_key to clients.
    return result.openid;
  };
}
class SessionStore {
  constructor({clock=Date.now,ttl=24*60*60*1000}={}){this.sessions=new Map();this.tokens=new Map();this.wechatUsers=new Map();this.clock=clock;this.ttl=ttl;}
  create(name,kind='guest',openid=null){
    if(this.sessions.size>=5000)throw new AuthError('服务器繁忙',503);
    const s={id:crypto.randomUUID(),name,kind,openid,ws:null,room:null,updated:this.clock(),token:null,expiresAt:0};
    this.sessions.set(s.id,s);if(openid)this.wechatUsers.set(openid,s);this.rotate(s);return s;
  }
  rotate(s){if(s.token)this.tokens.delete(s.token);s.token=crypto.randomBytes(24).toString('hex');s.expiresAt=this.clock()+this.ttl;this.tokens.set(s.token,s);}
  wechat(openid,name){let s=this.wechatUsers.get(openid);if(!s)return this.create(name,'wechat',openid);if(!s.room)s.name=name;s.updated=this.clock();this.rotate(s);return s;}
  fromToken(token){if(typeof token!=='string')return null;const s=this.tokens.get(token);return s&&s.expiresAt>this.clock()?s:null;}
  remove(s){this.sessions.delete(s.id);this.tokens.delete(s.token);if(s.openid)this.wechatUsers.delete(s.openid);}
}
module.exports={createWechatExchange,SessionStore,AuthError};
