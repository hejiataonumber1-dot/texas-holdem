const config=require('./config');
const TOKEN_KEY='poker-wechat-token';
function login(name){
  return new Promise((resolve,reject)=>{
    wx.login({timeout:10000,success(result){
      if(!result.code){reject(Error('获取微信登录凭证失败，请重试'));return;}
      wx.request({url:config.apiBaseUrl+'/api/auth/wechat',method:'POST',timeout:15000,header:{'content-type':'application/json'},data:{code:result.code,name},
        success(response){const data=response.data||{};if(response.statusCode!==200||typeof data.token!=='string'){reject(Error(data.message||'微信登录失败'));return;}wx.setStorageSync(TOKEN_KEY,data.token);resolve(data.token);},
        fail(){reject(Error('无法连接登录服务，请检查服务端和 Request 合法域名'));}});
    },fail(){reject(Error('微信登录失败，请确认当前 AppID 与开发者权限'));}});
  });
}
module.exports={login,TOKEN_KEY};
