const el=(tag,text)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;return node;};

/** Credentials travel only to the local login endpoint; the host owns the in-memory session. */
export function createLocalAuth({onLogin,onLogout}){
 const dialog=el('dialog');dialog.className='settings-dialog';dialog.setAttribute('aria-label','登录本地账号');
 const heading=el('div');heading.className='dialog-heading';const close=el('button','关闭');close.type='button';close.onclick=()=>dialog.close();heading.append(el('h2','登录本地账号'),close);
 const form=el('form'),username=el('input'),password=el('input'),status=el('p');
 username.type='text';username.name='username';username.autocomplete='username';username.required=true;username.maxLength=80;username.autocapitalize='none';username.spellcheck=false;
 password.type='password';password.name='password';password.autocomplete='current-password';password.required=true;password.maxLength=200;
 const userLabel=el('label','用户名'),passwordLabel=el('label','密码');userLabel.append(username);passwordLabel.append(password);
 const submit=el('button','登录');submit.type='submit';submit.className='primary-button';status.className='settings-status';status.setAttribute('role','status');
 form.append(userLabel,passwordLabel,submit);dialog.append(heading,el('p','使用此工作区管理员创建的本地账号。'),form,status);document.body.append(dialog);
 let busy=false;
 function lock(value){busy=value;for(const control of [username,password,submit,close])control.disabled=value;}
 async function post(path,body,token){
  const response=await fetch(path,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json',...(token?{'X-DataEngine-Token':token}:{})},body:JSON.stringify(body)});
  let result;try{result=await response.json();}catch{throw new Error('本地服务没有返回有效结果，请稍后重试。');}
  if(!response.ok)throw new Error(path.endsWith('/login')?'用户名或密码不正确，或登录暂不可用。':'退出未完成，请检查本地服务后重试。');
  return result;
 }
 form.onsubmit=event=>{event.preventDefault();if(busy||!form.reportValidity())return;
  const input={username:username.value.trim(),password:password.value};lock(true);status.textContent='正在登录…';
  void(async()=>{try{
   const result=await post('/api/auth/login',input);
   if(typeof result.token!=='string'||!result.token||!result.user)throw new Error('本地服务未返回有效登录状态。');
   await onLogin({token:result.token,user:result.user});dialog.close();
  }catch(error){status.textContent=error.message;}finally{input.password='';password.value='';lock(false);}})();
 };
 dialog.oncancel=event=>{if(busy)event.preventDefault();};dialog.onclose=()=>{password.value='';status.textContent='';};
 return{
  openLogin(){if(busy)return;password.value='';status.textContent='';if(!dialog.open)dialog.showModal();username.focus();},
  async logout(token){if(busy)return;lock(true);try{await post('/api/auth/logout',{},token);password.value='';lock(false);await onLogout();}finally{lock(false);}},
 };
}
