// Loaded only by the integration test's child process, never by the server normally.
global.fetch=async url=>{
  const request=new URL(url);
  if(request.origin!=='https://api.weixin.qq.com')throw Error('Unexpected test request');
  const code=request.searchParams.get('js_code');
  if(!['code-a','code-a-again','code-b'].includes(code))return new Response(JSON.stringify({errcode:40029}));
  return new Response(JSON.stringify({openid:code==='code-b'?'verified-b':'verified-a',session_key:'private-wechat-key'}));
};
