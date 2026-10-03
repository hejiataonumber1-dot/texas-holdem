const crypto=require('node:crypto');
function validatePassword(value){
  if(value===undefined||value==='')return '';
  if(typeof value!=='string'||value.length<4||value.length>32)throw Error('房间密码需要 4～32 个字符');
  return value;
}
function protectRoom(value){
  const password=validatePassword(value);
  if(!password)return null;
  const salt=crypto.randomBytes(16);
  return {salt,hash:crypto.scryptSync(password,salt,32)};
}
function matchesPassword(protection,value){
  if(!protection)return true;
  if(typeof value!=='string'||value.length<4||value.length>32)return false;
  return crypto.timingSafeEqual(protection.hash,crypto.scryptSync(value,protection.salt,32));
}
module.exports={protectRoom,matchesPassword};
