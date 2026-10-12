/* Household Wealth Profiler: sign-in for the Supabase edition.
   Loaded only when config.js sets supabaseUrl. Shows sign-in, "choose a password" (invite and
   reset links) and two-step verification with an authenticator app, then hands app.js a
   session whose token the API accepts. */
(function(){
'use strict';
const C=window.HWP_CONFIG||{};
const SDK={src:'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/dist/umd/supabase.js',integrity:'sha384-Rj26LVGvoeRVR6+mwQmFfcR3QOBEwT+ZmuCWpuiqeTzJpCs0ER4ITAWGb4Hiy3Ok'};
const $=s=>document.querySelector(s);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function loadSdk(){if(window.supabase)return Promise.resolve();return new Promise((ok,fail)=>{const s=document.createElement('script');s.src=SDK.src;s.integrity=SDK.integrity;s.crossOrigin='anonymous';s.onload=ok;s.onerror=()=>fail(new Error('Could not load the sign-in library. Check your connection.'));document.head.appendChild(s)})}

/* One screen at a time; resolves with the submitted form values. An error from the previous
   attempt (set with fail) is shown on the next screen. */
let pendingErr='';
const fail=m=>{pendingErr=m};
function screen(title,intro,fields,submit,extra=''){
  document.body.classList.add('gated');
  $('#main').innerHTML=`<form class="panel gate" id="gate" novalidate><h2>${esc(title)}</h2>${intro?`<p class="muted">${intro}</p>`:''}
    <div class="fields">${fields.map(f=>`<div class="f"><label for="g-${f.k}">${esc(f.l)}</label><input id="g-${f.k}" name="${f.k}" type="${f.t||'text'}" value="${esc(f.v||'')}" autocomplete="${f.ac||'off'}" ${f.im?`inputmode="${f.im}"`:''} required></div>`).join('')}</div>
    <p class="gate-err" id="gateErr" role="alert">${esc(pendingErr)}</p><div class="addrow"><button class="btn primary" type="submit">${esc(submit)}</button>${extra}</div></form>`;
  pendingErr='';
  const form=$('#gate');(form.querySelector('input[value=""]')||form.querySelector('input'))?.focus();
  return new Promise(ok=>{form.onsubmit=e=>{e.preventDefault();ok(Object.fromEntries(new FormData(form)))};form.onclick=e=>{const b=e.target.closest('[data-gate]');if(b){e.preventDefault();ok({action:b.dataset.gate})}}});
}

async function gate(){
  await loadSdk();
  const sb=window.supabase.createClient(C.supabaseUrl,C.supabaseKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
  const url=new URL(location.href);const wantsPassword=url.searchParams.has('setpw')||/type=(invite|recovery)/.test(location.hash);
  let {data:{session}}=await sb.auth.getSession();

  if(session&&wantsPassword){
    for(;;){const v=await screen('Choose your password','Use at least 12 characters with upper and lower case letters and a number.',[{k:'pw',l:'New password',t:'password',ac:'new-password'},{k:'pw2',l:'Repeat it',t:'password',ac:'new-password'}],'Save password');
      if(v.pw!==v.pw2){fail('The two passwords do not match.');continue}
      const {error}=await sb.auth.updateUser({password:v.pw});if(error){fail(error.message);continue}break}
    url.searchParams.delete('setpw');history.replaceState(null,'',url.pathname+url.search);
  }
  let lastEmail='';
  while(!session){
    const v=await screen('Sign in',C.firmHint?esc(C.firmHint):'',[{k:'email',l:'Email',t:'email',ac:'username',v:lastEmail},{k:'pw',l:'Password',t:'password',ac:'current-password'}],'Sign in','<button class="btn ghost" type="button" data-gate="forgot">Forgotten password?</button>');
    if(v.action==='forgot'){const e=await screen('Reset your password','We will email you a link to choose a new one.',[{k:'email',l:'Email',t:'email',ac:'username'}],'Send link','<button class="btn ghost" type="button" data-gate="back">Back</button>');
      if(e.email){await sb.auth.resetPasswordForEmail(e.email,{redirectTo:location.origin+location.pathname+'?setpw=1'});await screen('Check your email','If that address has an account, a reset link is on its way. You can close this page.',[],'Back to sign in')}
      continue}
    lastEmail=v.email;
    const {data,error}=await sb.auth.signInWithPassword({email:v.email,password:v.pw});
    if(error){await new Promise(r=>setTimeout(r,400));fail(error.message==='Invalid login credentials'?'Email or password is wrong.':error.message);continue}
    session=data.session;
  }

  if(C.requireMfa!==false){
    for(;;){
      const {data:al}=await sb.auth.mfa.getAuthenticatorAssuranceLevel();
      if(al.currentLevel==='aal2')break;
      const {data:fs}=await sb.auth.mfa.listFactors();
      const verified=(fs.totp||[])[0];
      if(verified){
        const v=await screen('Two-step verification','Enter the 6-digit code from your authenticator app.',[{k:'code',l:'Code',ac:'one-time-code',im:'numeric'}],'Verify','<button class="btn ghost" type="button" data-gate="out">Sign out</button>');
        if(v.action==='out'){await sb.auth.signOut();location.reload();return new Promise(()=>{})}
        const {error}=await sb.auth.mfa.challengeAndVerify({factorId:verified.id,code:String(v.code).replace(/\s/g,'')});if(error)fail('That code did not work. Check the time on your phone and try again.');continue}
      for(const f of (fs.all||[]).filter(f=>f.status==='unverified'))await sb.auth.mfa.unenroll({factorId:f.id});
      const {data:en,error:ee}=await sb.auth.mfa.enroll({factorType:'totp',friendlyName:'Authenticator '+new Date().toISOString().slice(0,10)});
      if(ee){await screen('Two-step verification',esc(ee.message),[],'Try again');continue}
      const qr=`<img class="gate-qr" alt="QR code for your authenticator app" src="${esc(en.totp.qr_code)}"><br>Or enter this key: <code>${esc(en.totp.secret)}</code>`;
      for(;;){const v=await screen('Set up two-step verification','Client records need a second step at sign-in. Scan this with an authenticator app (Microsoft Authenticator, Google Authenticator, 1Password), then enter the code it shows.<br>'+qr,[{k:'code',l:'Code',ac:'one-time-code',im:'numeric'}],'Turn on');
        const {error}=await sb.auth.mfa.challengeAndVerify({factorId:en.id,code:String(v.code).replace(/\s/g,'')});if(!error)break;fail('That code did not work. Try the next one.')}
    }
  }
  document.body.classList.remove('gated');$('#main').innerHTML='';
  return {
    async token(){const {data}=await sb.auth.getSession();return data.session?data.session.access_token:''},
    async signOut(){await sb.auth.signOut()},
  };
}
window.HWPCloud={enabled:!!C.supabaseUrl,gate};
})();
