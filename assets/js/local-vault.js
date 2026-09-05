/*
 * Internal Beyond local vault
 *
 * Keeps the existing JSON export/import flow intact while adding an opt-in,
 * password-encrypted backup format.  No password, derived key, or plaintext
 * backup is persisted by this module.
 */
(function(NS){
  'use strict';

  var VAULT_FORMAT='InternalBeyondEncryptedBackup';
  var VAULT_VERSION=1;
  var PBKDF2_ITERATIONS=310000;
  var root=null,modal=null,lastFocused=null,pendingEnvelope=null,auditBusy=false;
  var nativeExport=typeof window.exportAll==='function'?window.exportAll:null;
  var nativeImport=typeof window.importAll==='function'?window.importAll:null;

  var STORE_LABELS={
    chatMessages:'聊天记录',posts:'日志',letters:'信件',memories:'记忆库',apiConfigs:'API 配置',
    apiSettings:'系统设置',projects:'ICode 项目',projectFiles:'ICode 文件',uploadedFiles:'上传文件',
    chatThreads:'话题频道',chatSummaries:'对话摘要',blogComments:'日志留言',blogAnnotations:'日志批注',
    autoMemory:'Auto Memory',calEvents:'日程',calNotes:'日历便笺',calLedger:'日历设置',groups:'群聊',
    categories:'分类',about:'个人资料',active_message_settings:'主动消息设置',
    active_message_history:'主动消息历史',active_message_plans:'主动计划',diary_entries:'角色日记',music:'音乐',
    activities:'陪伴活动',favorites:'收藏夹'
  };

  function say(message){
    try{if(typeof window.toast==='function'){window.toast(message);return}}catch(e){}
    try{console.info('[Local Vault]',message)}catch(e2){}
  }
  function byId(id){return document.getElementById(id)}
  function cryptoSupported(){return !!(window.crypto&&window.crypto.subtle&&window.crypto.getRandomValues&&window.TextEncoder&&window.TextDecoder&&window.btoa&&window.atob)}
  function formatBytes(bytes){
    var n=Number(bytes)||0,units=['B','KB','MB','GB'],idx=0;
    while(n>=1024&&idx<units.length-1){n/=1024;idx++}
    return (idx===0?Math.round(n):n.toFixed(n>=100?0:n>=10?1:2))+' '+units[idx];
  }
  function formatDate(value){
    if(!value)return '尚未创建';
    var d=new Date(value);
    return isNaN(d.getTime())?'未知':d.toLocaleString('zh-CN',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
  }
  function dayStamp(){return new Date().toISOString().slice(0,10)}
  function randomBytes(length){var out=new Uint8Array(length);window.crypto.getRandomValues(out);return out}
  function bytesToBase64(bytes){
    var out='',step=0x8000;
    for(var i=0;i<bytes.length;i+=step)out+=String.fromCharCode.apply(null,bytes.subarray(i,Math.min(i+step,bytes.length)));
    return window.btoa(out);
  }
  function base64ToBytes(value){
    var raw=window.atob(String(value||'')),out=new Uint8Array(raw.length);
    for(var i=0;i<raw.length;i++)out[i]=raw.charCodeAt(i);
    return out;
  }
  function hasOwn(obj,key){return Object.prototype.hasOwnProperty.call(obj,key)}
  function isEnvelope(value){return !!(value&&typeof value==='object'&&value.format===VAULT_FORMAT&&Number(value.version)===VAULT_VERSION&&value.kdf&&value.ciphertext)}
  function looksLikeVault(value){return !!(value&&typeof value==='object'&&String(value.format||'').indexOf('InternalBeyondEncrypted')===0)}
  function validPayload(value){
    if(!value||Array.isArray(value)||typeof value!=='object')return false;
    return hasOwn(value,'version')||hasOwn(value,'exportDate')||hasOwn(value,'posts')||hasOwn(value,'chatMessages')||hasOwn(value,'apiConfigs');
  }
  function isLikelyBinary(value){
    return !!(value&&(typeof Blob!=='undefined'&&value instanceof Blob||typeof File!=='undefined'&&value instanceof File||typeof ArrayBuffer!=='undefined'&&value instanceof ArrayBuffer||typeof ArrayBuffer!=='undefined'&&ArrayBuffer.isView&&ArrayBuffer.isView(value)));
  }
  function findBinary(value,seen){
    if(isLikelyBinary(value))return true;
    if(!value||typeof value!=='object')return false;
    seen=seen||new WeakSet();
    if(seen.has(value))return false;seen.add(value);
    var keys=Object.keys(value);
    for(var i=0;i<keys.length;i++)if(findBinary(value[keys[i]],seen))return true;
    return false;
  }
  function clearInputs(){
    var password=byId('ib-vault-password'),confirmPassword=byId('ib-vault-password-confirm'),show=byId('ib-vault-show-password');
    if(password){password.value='';password.type='password'}
    if(confirmPassword){confirmPassword.value='';confirmPassword.type='password'}
    if(show)show.checked=false;
  }
  function setModalBusy(busy){
    var button=byId('ib-vault-modal-submit'),cancel=byId('ib-vault-modal-cancel');
    if(button)button.disabled=!!busy;
    if(cancel)cancel.disabled=!!busy;
    if(modal)modal.classList.toggle('is-busy',!!busy);
  }
  function modalError(message){
    var error=byId('ib-vault-modal-error');
    if(!error)return;
    error.textContent=message||'';
    error.hidden=!message;
  }
  async function deriveKey(password,salt,usages){
    var material=await window.crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveKey']);
    return window.crypto.subtle.deriveKey({name:'PBKDF2',salt:salt,iterations:PBKDF2_ITERATIONS,hash:'SHA-256'},material,{name:'AES-GCM',length:256},false,usages);
  }
  async function encryptBackup(data,password){
    var salt=randomBytes(16),iv=randomBytes(12),key=await deriveKey(password,salt,['encrypt']);
    var plaintext=new TextEncoder().encode(JSON.stringify(data));
    var encrypted=await window.crypto.subtle.encrypt({name:'AES-GCM',iv:iv},key,plaintext);
    return {
      format:VAULT_FORMAT,
      version:VAULT_VERSION,
      createdAt:new Date().toISOString(),
      kdf:{name:'PBKDF2',hash:'SHA-256',iterations:PBKDF2_ITERATIONS,salt:bytesToBase64(salt)},
      cipher:{name:'AES-GCM',iv:bytesToBase64(iv)},
      ciphertext:bytesToBase64(new Uint8Array(encrypted))
    };
  }
  async function decryptBackup(envelope,password){
    if(!isEnvelope(envelope))throw new Error('这不是受支持的加密备份文件。');
    var kdf=envelope.kdf||{},cipher=envelope.cipher||{};
    var iterations=Number(kdf.iterations);
    if(kdf.name!=='PBKDF2'||kdf.hash!=='SHA-256'||!Number.isInteger(iterations)||iterations<100000||iterations>1000000||!kdf.salt||cipher.name!=='AES-GCM'||!cipher.iv)throw new Error('备份加密参数不完整或不受支持。');
    var salt,iv,ciphertext;
    try{salt=base64ToBytes(kdf.salt);iv=base64ToBytes(cipher.iv);ciphertext=base64ToBytes(envelope.ciphertext)}catch(e){throw new Error('备份文件已损坏（无法读取加密数据）。')}
    if(salt.length<16||iv.length!==12||ciphertext.length<17)throw new Error('备份文件已损坏（加密数据长度异常）。');
    try{
      var material=await window.crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveKey']);
      var key=await window.crypto.subtle.deriveKey({name:'PBKDF2',salt:salt,iterations:iterations,hash:'SHA-256'},material,{name:'AES-GCM',length:256},false,['decrypt']);
      var plaintext=await window.crypto.subtle.decrypt({name:'AES-GCM',iv:iv},key,ciphertext);
      var data=JSON.parse(new TextDecoder().decode(plaintext));
      if(!validPayload(data))throw new Error('解密后的内容不是有效的 Internal Beyond 备份。');
      return data;
    }catch(error){
      if(error&&/有效的 Internal Beyond/.test(error.message||''))throw error;
      throw new Error('密码不正确，或备份文件已损坏。');
    }
  }
  function downloadEncrypted(envelope){
    var text=JSON.stringify(envelope,null,2),blob=new Blob([text],{type:'application/json'}),a=document.createElement('a');
    a.href=URL.createObjectURL(blob);a.download='InternalBeyond_encrypted_'+dayStamp()+'.ibvault';
    document.body.appendChild(a);a.click();a.remove();setTimeout(function(NS){URL.revokeObjectURL(a.href)},300);
    try{localStorage.setItem('ib_vault_lastEncryptedBackup',JSON.stringify({createdAt:envelope.createdAt,bytes:blob.size}))}catch(e){}
  }
  function renderBackupMeta(){
    var el=byId('ib-vault-last-encrypted');if(!el)return;
    var info=null;try{info=JSON.parse(localStorage.getItem('ib_vault_lastEncryptedBackup')||'null')}catch(e){}
    el.textContent=info?formatDate(info.createdAt)+(info.bytes?' · '+formatBytes(info.bytes):''):'尚未在此浏览器创建';
  }
  function showModal(mode){
    if(!modal)return;
    lastFocused=document.activeElement;
    modal.dataset.mode=mode;
    var exporting=mode==='export';
    byId('ib-vault-modal-title').textContent=exporting?'创建加密备份':'解锁加密备份';
    byId('ib-vault-modal-desc').textContent=exporting?'使用一个不会上传或保存的密码，为完整本地存档创建 AES-256-GCM 加密文件。':'输入创建此备份时使用的密码。解密只在当前浏览器内完成，随后按普通导入规则增量合并。';
    byId('ib-vault-modal-confirm-row').hidden=!exporting;
    byId('ib-vault-modal-submit').textContent=exporting?'加密并下载':'解锁并导入';
    byId('ib-vault-password').setAttribute('autocomplete',exporting?'new-password':'current-password');
    modalError('');clearInputs();setModalBusy(false);modal.hidden=false;
    window.setTimeout(function(NS){var input=byId('ib-vault-password');if(input)input.focus()},0);
  }
  function closeModal(){
    if(!modal||modal.hidden)return;
    modal.hidden=true;clearInputs();modalError('');pendingEnvelope=null;
    if(lastFocused&&typeof lastFocused.focus==='function')try{lastFocused.focus()}catch(e){}
    lastFocused=null;
  }
  async function runEncryptedExport(){
    if(!cryptoSupported()){say('当前浏览器不支持 WebCrypto，无法创建加密备份。');return}
    if(typeof window._ibBuildExportData!=='function'){say('数据仍在初始化，请稍后再试。');return}
    showModal('export');
  }
  function runPlainExport(){
    if(typeof nativeExport==='function')nativeExport();
    else say('普通导出暂不可用，请刷新页面后重试。');
  }
  function openFilePicker(){
    var input=byId('importFile');
    if(input)input.click();
  }
  async function submitModal(){
    var password=byId('ib-vault-password'),confirmPassword=byId('ib-vault-password-confirm'),mode=modal&&modal.dataset.mode;
    var value=password?password.value:'';
    if(value.length<12){modalError('请使用至少 12 个字符的备份密码。');if(password)password.focus();return}
    if(mode==='export'&&(!confirmPassword||value!==confirmPassword.value)){modalError('两次输入的密码不一致。');if(confirmPassword)confirmPassword.focus();return}
    setModalBusy(true);modalError('');
    try{
      if(mode==='export'){
        var data=await window._ibBuildExportData();
        if(findBinary(data))throw new Error('当前存档含有浏览器二进制文件，无法安全写入加密 JSON。请先用「普通 JSON」导出，或移除这些文件后再试。');
        var envelope=await encryptBackup(data,value);
        downloadEncrypted(envelope);renderBackupMeta();
        closeModal();say('已创建加密备份；请把密码与文件分开保存。');
      }else{
        if(!pendingEnvelope)throw new Error('没有待导入的加密备份，请重新选择文件。');
        var decrypted=await decryptBackup(pendingEnvelope,value);
        if(typeof nativeImport!=='function')throw new Error('普通导入器不可用，请刷新页面后重试。');
        var file=new File([JSON.stringify(decrypted)],'InternalBeyond_decrypted_import.json',{type:'application/json'});
        await nativeImport({target:{files:[file],value:''}});
        try{localStorage.setItem('ib_vault_lastEncryptedImport',new Date().toISOString())}catch(e){}
        closeModal();window.setTimeout(renderQuickHealth,400);
      }
    }catch(error){
      modalError(String(error&&error.message||error||'操作失败，请重试。'));
      setModalBusy(false);
    }
  }
  async function interceptImport(event){
    var input=event&&event.target,file=input&&input.files&&input.files[0];
    if(!file)return;
    var parsed=null;
    try{parsed=JSON.parse(await file.text())}catch(e){
      if(typeof nativeImport==='function')return nativeImport(event);
      say('导入失败：文件格式错误。');return;
    }
    if(isEnvelope(parsed)){
      if(input)input.value='';
      if(!cryptoSupported()){say('当前浏览器不支持 WebCrypto，无法解锁此加密备份。');return}
      pendingEnvelope=parsed;showModal('import');return;
    }
    if(looksLikeVault(parsed)){
      if(input)input.value='';
      say('该加密备份版本不受支持或文件已损坏。');return;
    }
    if(typeof nativeImport==='function')return nativeImport(event);
    say('导入器不可用，请刷新页面后重试。');
  }
  function safeJSONString(value){
    var seen=typeof WeakSet==='function'?new WeakSet():null;
    try{return JSON.stringify(value,function(key,item){
      if(typeof item==='bigint')return String(item);
      if(typeof Blob!=='undefined'&&item instanceof Blob)return {type:item.type||'blob',size:item.size,__ibBlob:true};
      if(item&&typeof item==='object'){
        if(seen){if(seen.has(item))return '[Circular]';seen.add(item)}
      }
      return item;
    })||''}catch(e){return ''}
  }
  function valueSize(value){
    var text=safeJSONString(value);
    try{return new Blob([text]).size}catch(e){return text.length*2}
  }
  function readLocalJson(key){try{return JSON.parse(localStorage.getItem(key)||'null')}catch(e){return null}}
  function setHealthState(kind,text){
    var badge=byId('ib-vault-health-badge'),summary=byId('ib-vault-health-summary');
    if(badge){badge.className='ib-vault-health-badge '+kind;badge.textContent=kind==='good'?'状态良好':kind==='warn'?'需要留意':'检查未完成'}
    if(summary)summary.textContent=text;
  }
  function renderAudit(data){
    var list=byId('ib-vault-health-list'),details=byId('ib-vault-health-details');
    if(!list||!details)return;
    list.innerHTML='';
    var important=data.breakdown.slice(0,6);
    if(!important.length){
      var empty=document.createElement('div');empty.className='ib-vault-health-empty';empty.textContent='尚未发现可计量的本站数据。';list.appendChild(empty);
    }else{
      important.forEach(function(item){
        var row=document.createElement('div');row.className='ib-vault-health-row';
        var label=document.createElement('span');label.textContent=item.label;
        var value=document.createElement('span');value.textContent=formatBytes(item.bytes)+' · '+item.count+' 条';
        row.appendChild(label);row.appendChild(value);list.appendChild(row);
      });
    }
    var lines=[];
    lines.push('可读性：'+(data.readErrors.length?'有 '+data.readErrors.length+' 个数据表无法读取（'+data.readErrors.join('、')+'）':'已读取 '+data.storeCount+' 个数据表，未见读取错误')+'。');
    lines.push('估算占用：'+(data.estimate&&typeof data.estimate.usage==='number'?formatBytes(data.estimate.usage)+' / '+formatBytes(data.estimate.quota||0):'浏览器未提供配额信息')+'。');
    lines.push('紧急镜像：'+(data.mirror?formatDate(data.mirror.ts)+(Object.keys(data.mirror.truncated||{}).length?' · 有精简':' · 完整元数据'):'尚未生成')+'。');
    lines.push('自动下载：'+(data.autoOn?'已开启':'未开启')+(data.autoLast?' · 上次 '+data.autoLast:'')+'。');
    lines.push('加密备份：'+(data.encrypted?formatDate(data.encrypted.createdAt):'尚未在此浏览器创建')+'。');
    details.textContent=lines.join('\n');
  }
  async function runHealthAudit(){
    if(auditBusy)return;
    auditBusy=true;
    var button=byId('ib-vault-run-health');if(button){button.disabled=true;button.textContent='检查中…'}
    setHealthState('pending','正在读取本地数据表与浏览器存储状态…');
    try{
      if(typeof db==='undefined'||!db)throw new Error('本地数据库仍在初始化，请稍后重试。');
      var names=Array.prototype.slice.call(db.objectStoreNames||[]),breakdown=[],readErrors=[],total=0;
      for(var i=0;i<names.length;i++){
        var name=names[i];
        try{
          var records=await dbGetAll(name),bytes=0;
          for(var j=0;j<records.length;j++)bytes+=valueSize(records[j]);
          total+=bytes;
          if(records.length||bytes)breakdown.push({name:name,label:STORE_LABELS[name]||name,count:records.length,bytes:bytes});
        }catch(error){readErrors.push(STORE_LABELS[name]||name)}
      }
      breakdown.sort(function(a,b){return b.bytes-a.bytes});
      var estimate=null,persisted=null;
      try{if(navigator.storage&&navigator.storage.estimate)estimate=await navigator.storage.estimate()}catch(e){}
      try{if(navigator.storage&&navigator.storage.persisted)persisted=await navigator.storage.persisted()}catch(e2){}
      var mirror=readLocalJson('ib_mirror_meta'),autoOn=false,autoLast='',encrypted=readLocalJson('ib_vault_lastEncryptedBackup');
      try{autoOn=localStorage.getItem('ib_autoBak')==='1';autoLast=localStorage.getItem('ib_autoBakLast')||''}catch(e3){}
      var warnings=[];
      if(readErrors.length)warnings.push('部分数据表无法读取');
      if(persisted===false)warnings.push('浏览器未确认持久化存储');
      if(estimate&&estimate.quota&&estimate.usage/estimate.quota>=0.8)warnings.push('浏览器存储空间已超过 80%');
      if(total>0&&!mirror)warnings.push('尚无紧急镜像');
      renderAudit({breakdown:breakdown,readErrors:readErrors,storeCount:names.length,estimate:estimate,mirror:mirror,autoOn:autoOn,autoLast:autoLast,encrypted:encrypted});
      if(warnings.length)setHealthState('warn','已计量 '+formatBytes(total)+' · '+warnings.join('；')+'。');
      else setHealthState('good','已计量 '+formatBytes(total)+' · '+names.length+' 个数据表均可读取。');
    }catch(error){
      setHealthState('pending',String(error&&error.message||error||'健康检查失败。'));
    }finally{
      auditBusy=false;
      if(button){button.disabled=false;button.textContent='运行健康检查'}
    }
  }
  function renderQuickHealth(){
    renderBackupMeta();
    var quick=byId('ib-vault-health-summary');
    if(!quick||auditBusy)return;
    var mirrored=readLocalJson('ib_mirror_meta'),encrypted=readLocalJson('ib_vault_lastEncryptedBackup');
    var parts=[];
    if(mirrored)parts.push('紧急镜像 '+formatDate(mirrored.ts));
    if(encrypted)parts.push('加密备份 '+formatDate(encrypted.createdAt));
    if(!parts.length)parts.push('尚未运行完整检查');
    quick.textContent=parts.join(' · ');
  }
  function mount(){
    root=byId('ib-local-vault-root');
    if(!root||root.dataset.mounted)return;
    root.dataset.mounted='1';
    root.innerHTML=''
      +'<section class="ib-vault-card" aria-labelledby="ib-vault-title">'
      +'<div class="ib-vault-card-head"><div><h3 id="ib-vault-title">加密备份</h3><p>完整存档可用仅在本机派生的密码加密；密码不会保存、不会上传，也无法找回。</p></div><span class="ib-vault-lock" aria-hidden="true">⌑</span></div>'
      +'<div class="ib-vault-actions">'
      +'<button type="button" class="btn" data-ib-vault-action="encrypted-export">创建加密备份</button>'
      +'<button type="button" class="btn btn-compact" data-ib-vault-action="plain-export">普通 JSON</button>'
      +'<button type="button" class="btn btn-compact" data-ib-vault-action="import">导入备份</button>'
      +'</div>'
      +'<div class="ib-vault-facts"><span>算法 <b>AES-256-GCM</b></span><span>密钥派生 <b>PBKDF2 · '+PBKDF2_ITERATIONS.toLocaleString('en-US')+' 次</b></span><span>此浏览器最近加密备份 <b id="ib-vault-last-encrypted">读取中…</b></span></div>'
      +'<p class="ib-vault-note">普通 JSON 仍适合跨设备迁移，但会包含存档中的 API 密钥。加密备份适合长期留存；请将密码与备份文件分开保管。</p>'
      +'</section>'
      +'<section class="ib-vault-card ib-vault-health" aria-labelledby="ib-vault-health-title">'
      +'<div class="ib-vault-card-head"><div><h3 id="ib-vault-health-title">本地数据健康</h3><p id="ib-vault-health-summary" aria-live="polite">尚未运行完整检查</p></div><span id="ib-vault-health-badge" class="ib-vault-health-badge pending">等待检查</span></div>'
      +'<div id="ib-vault-health-list" class="ib-vault-health-list"><div class="ib-vault-health-empty">检查会统计各模块占用、浏览器配额和数据表可读性。</div></div>'
      +'<pre id="ib-vault-health-details" class="ib-vault-health-details">不会上传任何数据。</pre>'
      +'<div class="ib-vault-actions"><button type="button" class="btn btn-compact" id="ib-vault-run-health">运行健康检查</button><button type="button" class="btn btn-compact" data-ib-vault-action="mirror">立即更新紧急镜像</button></div>'
      +'</section>';
    root.addEventListener('click',function(event){
      var action=event.target&&event.target.closest&&event.target.closest('[data-ib-vault-action]');
      if(!action)return;
      var type=action.getAttribute('data-ib-vault-action');
      if(type==='encrypted-export')runEncryptedExport();
      else if(type==='plain-export')runPlainExport();
      else if(type==='import')openFilePicker();
      else if(type==='mirror'){
        if(typeof window._ibMirrorNow==='function')window._ibMirrorNow(true);
        window.setTimeout(renderQuickHealth,250);
      }
    });
    var health=byId('ib-vault-run-health');if(health)health.addEventListener('click',runHealthAudit);
    renderQuickHealth();
  }
  function mountModal(){
    if(byId('ib-vault-modal')){modal=byId('ib-vault-modal');return}
    modal=document.createElement('div');modal.id='ib-vault-modal';modal.className='ib-vault-modal';modal.hidden=true;
    modal.setAttribute('role','dialog');modal.setAttribute('aria-modal','true');modal.setAttribute('aria-labelledby','ib-vault-modal-title');
    modal.innerHTML=''
      +'<div class="ib-vault-modal-card">'
      +'<div class="ib-vault-modal-head"><div><h2 id="ib-vault-modal-title">加密备份</h2><p id="ib-vault-modal-desc"></p></div><button type="button" class="ib-vault-close" id="ib-vault-modal-close" aria-label="关闭">×</button></div>'
      +'<div class="ib-vault-field"><label for="ib-vault-password">备份密码</label><input id="ib-vault-password" type="password" minlength="12" autocomplete="new-password" spellcheck="false" placeholder="至少 12 个字符"></div>'
      +'<div class="ib-vault-field" id="ib-vault-modal-confirm-row"><label for="ib-vault-password-confirm">再次输入密码</label><input id="ib-vault-password-confirm" type="password" minlength="12" autocomplete="new-password" spellcheck="false" placeholder="确认密码"></div>'
      +'<label class="ib-vault-show-password"><input id="ib-vault-show-password" type="checkbox"> 显示密码</label>'
      +'<p id="ib-vault-modal-error" class="ib-vault-modal-error" role="alert" hidden></p>'
      +'<p class="ib-vault-modal-footnote">忘记密码无法恢复数据。加密和解密均在本地完成。</p>'
      +'<div class="ib-vault-modal-actions"><button type="button" class="btn" id="ib-vault-modal-cancel">取消</button><button type="button" class="btn btn-primary" id="ib-vault-modal-submit">继续</button></div>'
      +'</div>';
    document.body.appendChild(modal);
    byId('ib-vault-modal-close').addEventListener('click',closeModal);
    byId('ib-vault-modal-cancel').addEventListener('click',closeModal);
    byId('ib-vault-modal-submit').addEventListener('click',submitModal);
    byId('ib-vault-show-password').addEventListener('change',function(){
      var type=this.checked?'text':'password';byId('ib-vault-password').type=type;byId('ib-vault-password-confirm').type=type;
    });
    modal.addEventListener('click',function(event){if(event.target===modal)closeModal()});
    modal.addEventListener('keydown',function(event){if(event.key==='Enter'&&event.target&&event.target.tagName==='INPUT'){event.preventDefault();submitModal()}});
    document.addEventListener('keydown',function(event){if(event.key==='Escape'&&modal&&!modal.hidden)closeModal()});
  }
  function hookApiPage(){
    if(typeof window.loadApiSettingsUI!=='function'||window.loadApiSettingsUI.__ibVaultWrapped)return;
    var original=window.loadApiSettingsUI;
    var wrapped=async function(){
      var result=await original.apply(this,arguments);
      window.setTimeout(renderQuickHealth,0);
      return result;
    };
    wrapped.__ibVaultWrapped=true;window.loadApiSettingsUI=wrapped;
  }
  function boot(){
    mount();mountModal();hookApiPage();
    window.importAll=interceptImport;
    var importInput=byId('importFile');
    if(importInput)importInput.accept='.json,.ibvault,application/json';
    /* 数据库就绪前先禁用加密导出，避免点击后读到未初始化/被吞掉错误而生成空备份；
       就绪后恢复（不支持 WebCrypto 时仍保持禁用，由下方逻辑提示）。 */
    var exportButton=root&&root.querySelector('[data-ib-vault-action="encrypted-export"]');
    if(exportButton&&typeof window.ensureDB==='function'){
      exportButton.disabled=true;
      Promise.resolve(window.ensureDB()).then(function(NS){
        if(exportButton&&cryptoSupported())exportButton.disabled=false;
      }).catch(function(NS){
        /* 打开失败时恢复可点击，让点击路径给出明确错误提示，而不是永久禁用 */
        if(exportButton&&cryptoSupported())exportButton.disabled=false;
      });
    }
    if(!cryptoSupported()){
      var button=root&&root.querySelector('[data-ib-vault-action="encrypted-export"]');if(button)button.disabled=true;
      var note=document.createElement('p');note.className='ib-vault-unsupported';note.textContent='当前浏览器未提供 WebCrypto；普通 JSON 导入导出和已有本地备份功能仍可使用。';root.querySelector('.ib-vault-card').appendChild(note);
    }
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);
  else boot();

/* ---- window.IB 命名空间迁移：登记所有权（副作用模块：拦截 importAll / 挂载保险库面板） ---- */
NS.expose('vault', { mounted: true, format: VAULT_FORMAT, version: VAULT_VERSION });
})(window.IB || (window.IB = {}));