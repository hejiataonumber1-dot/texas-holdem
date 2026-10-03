const $=id=>document.getElementById(id);
let busy=false;
async function api(path,body){const response=await fetch('/api/admin/'+path,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const data=await response.json();if(!response.ok){if(response.status===401)showLogin();throw Error(data.message||'请求失败');}return data;}
function showLogin(){$('admin-login').hidden=false;$('admin-console').hidden=true;$('issued-code').hidden=true;$('new-code-output').value='';}
function status(data){$('require-code').checked=data.requireCode;$('policy-status').textContent=data.requireCode?'当前：凭授权码创建房间':'当前：允许自由创建房间（每个连接来源 15 分钟最多 5 次）';$('admin-login').hidden=true;$('admin-console').hidden=false;$('code-status').textContent=data.enabled?`当前授权码可用 · 已创建 ${data.used} / ${data.maxUses} 个房间 · 剩余 ${data.remaining} 次 · 到期 ${new Date(data.expiresAt).toLocaleString()}`:'当前没有可用授权码；启用授权码模式时无法建房。';$('code-disable').disabled=!data.enabled;}
async function task(fn){if(busy)return;busy=true;$('admin-message').textContent='';try{await fn();}catch(e){$('admin-message').textContent=e.message;}finally{busy=false;}}
$('login-form').onsubmit=e=>{e.preventDefault();task(async()=>{status(await api('login',{username:$('admin-username').value,password:$('admin-password').value}));$('admin-password').value='';});};
$('code-form').onsubmit=e=>{e.preventDefault();task(async()=>{const data=await api('code',{code:$('authorization-code').value,days:Number($('code-days').value),maxUses:Number($('code-uses').value)});status(data);$('authorization-code').value='';$('new-code-output').value=data.code;$('issued-code').hidden=false;$('admin-message').textContent=data.requireCode?'新授权码已设置，旧码已失效。':'新授权码已保存，当前仍允许自由创建。如需限制建房，请开启「创建房间需要授权码」并保存创建方式。';});};
$('code-refresh').onclick=()=>task(async()=>status(await api('status')));
$('code-disable').onclick=()=>task(async()=>{status(await api('code',{enabled:false}));$('issued-code').hidden=true;$('new-code-output').value='';$('admin-message').textContent='授权码已停用，已创建的房间不受影响。';});
$('admin-logout').onclick=()=>task(async()=>{await api('logout',{});showLogin();});
$('copy-code').onclick=()=>task(async()=>{try{await navigator.clipboard.writeText($('new-code-output').value);$('admin-message').textContent='授权码已复制。';}catch{$('new-code-output').select();$('admin-message').textContent='请长按或使用 Ctrl+C 复制选中的授权码。';}});
task(async()=>status(await api('status')));

$('policy-form').onsubmit=e=>{e.preventDefault();task(async()=>{status(await api('policy',{requireCode:$('require-code').checked}));$('admin-message').textContent='创建方式已保存，立即生效。';});};
