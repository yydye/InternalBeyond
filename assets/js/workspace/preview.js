/* WORKSPACE PREVIEW —— 富文件支持（二进制嗅探 / 解析库缓存 / PDF·DOCX·XLSX·PPTX·RTF·EPUB 提取 / ZIP 工具 / PDF 密码）+ 预览面板 UI。自 workspace.js 机械提取（只动位置，不改逻辑；加载于 workspace.js 之前）。 */
(function(NS){
/* ── 二进制嗅探：头 1KB 里出现 NUL 字节即视为二进制（几乎所有真二进制格式开头都有 NUL） ── */
function _icodeLooksBinary(bytes){
  var n=Math.min(bytes.length,1024);
  for(var i=0;i<n;i++)if(bytes[i]===0)return true;
  return false;
}
async function _icodeSniffText(f){
  var head=new Uint8Array(await f.slice(0,1024).arrayBuffer());
  return head.length>0&&!_icodeLooksBinary(head);
}
/* ── 富文件支持（PDF / DOCX / XLSX / XLS / PPTX / RTF / EPUB）──────
   content 统一存 data:<mime>;base64,… 字符串。解析库不再直连 CDN：
   统一经「文件解析库」开关（DIY 页，默认关）联网获取一次后存入
   独立本地库缓存（IndexedDB: IB_LibCache），此后离线可用；开关关闭
   且本地无缓存时给出提示、不发起任何网络请求、不崩溃。
   文本提取供 AI 读取时注入；生成器（DOCX / PDF / XLSX）供 ws_make_* 指令调用。 */
var _ICODE_RICH_EXT=/\.(pdf|docx|xlsx|xls|pptx|rtf|epub)$/i;
function _icodeIsRich(name){return _ICODE_RICH_EXT.test(String(name||''))}
function _wsRichKind(name){var m=String(name||'').toLowerCase().match(_ICODE_RICH_EXT);return m?m[1]:''}
function _wsRichMime(name){
  var k=_wsRichKind(name);
  if(k==='pdf')return'application/pdf';
  if(k==='docx')return'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if(k==='xlsx')return'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if(k==='xls')return'application/vnd.ms-excel';
  if(k==='pptx')return'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  if(k==='rtf')return'application/rtf';
  if(k==='epub')return'application/epub+zip';
  return'application/octet-stream';
}
/* 解析库来源：pdf.js / mammoth / xlsx 沿用 cdnjs；docx 生成库 cdnjs 未收录，
   主源 jsDelivr、备源 unpkg；jsPDF 与 html2canvas 主源 cdnjs、备源 jsDelivr。均为开源许可。 */
var _WS_RICH_CDN={
  pdf:'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.9.155/pdf.min.mjs',
  pdfWorker:'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.9.155/pdf.worker.min.mjs',
  mammoth:'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.8.0/mammoth.browser.min.js',
  xlsx:'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
  docx:['https://cdn.jsdelivr.net/npm/docx@8.5.0/build/index.umd.min.js','https://unpkg.com/docx@8.5.0/build/index.umd.min.js'],
  jspdf:['https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js','https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js'],
  h2c:['https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js','https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js']
};
/* ── 解析库开关与本地库缓存 ──
   开关：localStorage ib_richLibs === '1' 才开（默认关）。
   缓存：独立数据库 IB_LibCache（与主库 InternalBeyondDB 完全隔离，
   不进全站导出、不影响既有版本迁移），key=库地址，value=库源码文本。 */
function _ibRichLibsOn(){try{return localStorage.getItem('ib_richLibs')==='1'}catch(e){return false}}
var _ibLibDbP=null;
function _ibLibDb(){
  if(_ibLibDbP)return _ibLibDbP;
  _ibLibDbP=new Promise(function(res,rej){
    var q=indexedDB.open('IB_LibCache',1);
    q.onupgradeneeded=function(){try{q.result.createObjectStore('libs')}catch(e){}};
    q.onsuccess=function(){res(q.result)};
    q.onerror=function(){rej(q.error||new Error('IB_LibCache 打开失败'))};
  });
  _ibLibDbP.catch(function(){_ibLibDbP=null});
  return _ibLibDbP;
}
function _ibLibGet(url){
  return _ibLibDb().then(function(db){return new Promise(function(res){
    try{var t=db.transaction('libs','readonly').objectStore('libs').get(url);
      t.onsuccess=function(){res(t.result||null)};t.onerror=function(){res(null)};
    }catch(e){res(null)}
  })}).catch(function(){return null});
}
function _ibLibPut(url,text){
  return _ibLibDb().then(function(db){return new Promise(function(res,rej){
    try{var t=db.transaction('libs','readwrite');t.objectStore('libs').put(text,url);
      t.oncomplete=function(){res()};t.onerror=function(){rej(t.error)};
    }catch(e){rej(e)}
  })});
}
function _ibLibClear(){
  return _ibLibDb().then(function(db){return new Promise(function(res,rej){
    try{var t=db.transaction('libs','readwrite');t.objectStore('libs').clear();
      t.oncomplete=function(){res()};t.onerror=function(){rej(t.error)};
    }catch(e){rej(e)}
  })});
}
function _wsLibErr(label,msg){var e=new Error('lib');e._wsLibMsg='['+(msg||('「'+label+'」解析库未就绪：请在 DIY 页开启「文件解析库」开关（首次需联网获取，此后离线可用）'))+']';return e}
/* 取库源码：本地缓存命中即离线返回；未命中且开关关闭 → 提示并拒绝； */
async function _wsFetchLibText(urls,label){
  urls=Array.isArray(urls)?urls:[urls];
  for(var i=0;i<urls.length;i++){var hit=await _ibLibGet(urls[i]);if(hit)return hit}
  if(!_ibRichLibsOn()){
    toast('「'+label+'」解析库未就绪：请在 DIY 页开启「文件解析库」');
    throw _wsLibErr(label);
  }
  var got=null;
  for(var j=0;j<urls.length;j++){
    try{
      var resp=await fetch(urls[j],{cache:'no-store'});
      if(!resp.ok)throw new Error('HTTP '+resp.status);
      got=await resp.text();
      try{await _ibLibPut(urls[j],got)}catch(e2){}
      try{_ibRichLibsRefreshCard()}catch(e3){}
      return got;
    }catch(e){}
  }
  toast('「'+label+'」解析库获取失败：请检查网络后重试');
  throw _wsLibErr(label,'「'+label+'」解析库获取失败：网络不可用或来源暂不可达，请稍后重试');
}
/* 库脚本懒加载：源码经 Blob URL 注入执行；同一库只加载一次；失败清缓存可重试 */
var _wsScriptCache={};
function _wsLoadScript(urls,label){
  var key=Array.isArray(urls)?urls[0]:urls;
  if(_wsScriptCache[key])return _wsScriptCache[key];
  _wsScriptCache[key]=(async function(){
    var text=await _wsFetchLibText(urls,label);
    var blobUrl=URL.createObjectURL(new Blob([text],{type:'text/javascript'}));
    try{
      await new Promise(function(resolve,reject){
        var s=document.createElement('script');
        s.src=blobUrl;
        s.onload=function(){resolve()};
        s.onerror=function(){s.remove();reject(_wsLibErr(label,'「'+label+'」解析库执行失败，可尝试在 DIY 页清除已下载后重新获取'))};
        document.head.appendChild(s);
      });
    }finally{setTimeout(function(){try{URL.revokeObjectURL(blobUrl)}catch(e){}},4000)}
  })();
  _wsScriptCache[key].catch(function(){delete _wsScriptCache[key]});
  return _wsScriptCache[key];
}
/* pdf.js 4.x 为 ES module：主件与工作线程都经缓存管线取回，再以 Blob URL 动态 import */
var _wsPdfLibPromise=null;
function _wsLoadPdfJs(){
  if(_wsPdfLibPromise)return _wsPdfLibPromise;
  _wsPdfLibPromise=(async function(){
    var mainT=await _wsFetchLibText(_WS_RICH_CDN.pdf,'PDF');
    var workT=await _wsFetchLibText(_WS_RICH_CDN.pdfWorker,'PDF');
    var mainU=URL.createObjectURL(new Blob([mainT],{type:'text/javascript'}));
    var workU=URL.createObjectURL(new Blob([workT],{type:'text/javascript'}));
    var lib=await import(mainU);
    lib.GlobalWorkerOptions.workerSrc=workU;
    return lib;
  })();
  _wsPdfLibPromise.catch(function(){_wsPdfLibPromise=null});
  return _wsPdfLibPromise;
}
/* 字节 ⇄ base64 data URL 互转（分块拼接，避免大文件超出调用栈上限） */
function _wsBytesToDataUrl(bytes,mime){
  var CHUNK=0x8000,parts=[];
  for(var i=0;i<bytes.length;i+=CHUNK)parts.push(String.fromCharCode.apply(null,bytes.subarray(i,i+CHUNK)));
  return 'data:'+mime+';base64,'+btoa(parts.join(''));
}
async function _wsFileToDataUrl(file,name){
  var bytes=new Uint8Array(await file.arrayBuffer());
  return _wsBytesToDataUrl(bytes,_wsRichMime(name));
}
function _wsDataUrlToBytes(dataUrl){
  var s=String(dataUrl),b64=s.slice(s.indexOf(',')+1);
  var bin=atob(b64),n=bin.length,bytes=new Uint8Array(n);
  for(var i=0;i<n;i++)bytes[i]=bin.charCodeAt(i);
  return bytes;
}
function _wsBase64ToBlob(dataUrl){
  var m=String(dataUrl).match(/^data:([^;,]+)/);
  return new Blob([_wsDataUrlToBytes(dataUrl)],{type:(m&&m[1])||'application/octet-stream'});
}
/* ── ZIP 只读工具（供 DOCX 兜底 / PPTX / EPUB / DOCX 图片提取复用）──
   与下方导入用 ZIP 读取器同一套解析逻辑：中央目录定位条目，
   STORED 直接切片、DEFLATE 走 DecompressionStream('deflate-raw')。 */
function _wsZipList(bytes){
  var buf=bytes,dv=new DataView(buf.buffer,buf.byteOffset,buf.byteLength);
  var eocd=-1,lo=Math.max(0,buf.length-22-65535);
  for(var i=buf.length-22;i>=lo;i--){if(dv.getUint32(i,true)===0x06054b50){eocd=i;break}}
  if(eocd<0)throw new Error('不是有效的 ZIP 结构');
  var count=dv.getUint16(eocd+10,true),cdOff=dv.getUint32(eocd+16,true);
  if(count===0xffff||cdOff===0xffffffff)throw new Error('不支持 ZIP64');
  var ents=[],p=cdOff;
  for(var n=0;n<count;n++){
    if(p+46>buf.length||dv.getUint32(p,true)!==0x02014b50)break;
    var flags=dv.getUint16(p+8,true),method=dv.getUint16(p+10,true);
    var csize=dv.getUint32(p+20,true),usize=dv.getUint32(p+24,true);
    var nlen=dv.getUint16(p+28,true),elen=dv.getUint16(p+30,true),clen=dv.getUint16(p+32,true);
    var lho=dv.getUint32(p+42,true);
    var nm=_icodeZipName(buf.subarray(p+46,p+46+nlen),flags);
    p+=46+nlen+elen+clen;
    ents.push({name:nm,flags:flags,method:method,csize:csize,usize:usize,lho:lho});
  }
  return ents;
}
async function _wsZipRead(bytes,en){
  var buf=bytes,dv=new DataView(buf.buffer,buf.byteOffset,buf.byteLength);
  if(en.flags&0x1)throw new Error('加密条目');
  var lp=en.lho;
  if(lp+30>buf.length||dv.getUint32(lp,true)!==0x04034b50)throw new Error('条目头损坏');
  var lnl=dv.getUint16(lp+26,true),lel=dv.getUint16(lp+28,true);
  var start=lp+30+lnl+lel;
  if(start+en.csize>buf.length)throw new Error('条目数据越界');
  var raw=buf.subarray(start,start+en.csize);
  if(en.method===0)return raw;
  if(en.method===8){
    if(typeof DecompressionStream==='undefined')throw new Error('浏览器不支持在线解压');
    return new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
  }
  throw new Error('不支持的压缩方式');
}
function _wsXmlUnescape(s){
  return String(s||'')
    .replace(/&#x([0-9a-fA-F]+);/g,function(_,h){return String.fromCodePoint(parseInt(h,16))})
    .replace(/&#(\d+);/g,function(_,d){return String.fromCodePoint(parseInt(d,10))})
    .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&');
}
/* ── ── 文本提取：返回纯文本字符串供 AI 注入。失败/受限时返回「[…]」 ── */
var _wsRichTextCache={},_wsRichTextCacheKeys=[];
function _wsRichCacheKey(f){return ((f&&(f.id||f.path||f.name))||'')+'|'+((f&&(f.lastModified||f.size))||'')}
function _wsRichCacheDrop(f){
  var key=_wsRichCacheKey(f);
  if(_wsRichTextCache[key]!==undefined){delete _wsRichTextCache[key];var ix=_wsRichTextCacheKeys.indexOf(key);if(ix>-1)_wsRichTextCacheKeys.splice(ix,1)}
}
function _wsRichIsFailText(t){return typeof t==='string'&&t.charCodeAt(0)===91&&/(无法|失败|已加密|没有可提取|未就绪|不支持)/.test(t.slice(0,60))}
/* 环境性失败（库未就绪/获取失败/执行失败）：属开关与网络状态而非文件本身的属性，不进提取缓存 */
function _wsRichEnvFail(t){return /解析库(未就绪|获取失败|执行失败)/.test(String(t||'').slice(0,80))}
async function _wsExtractRichText(f){
  var name=f&&(f.path||f.name)||'';
  var kind=_wsRichKind(name);
  var content=f&&typeof f.content==='string'?f.content:'';
  if(!kind||content.slice(0,5)!=='data:')return'[无法提取文本内容]';
  var key=_wsRichCacheKey(f);
  if(_wsRichTextCache[key]!==undefined)return _wsRichTextCache[key];
  var text='';
  try{
    if(kind==='pdf')text=await _wsExtractPdfText(f);
    else if(kind==='docx')text=await _wsExtractDocxText(content);
    else if(kind==='xlsx'||kind==='xls')text=await _wsExtractXlsxText(content);
    else if(kind==='pptx')text=await _wsExtractPptxText(_wsDataUrlToBytes(content));
    else if(kind==='rtf')text=await _wsExtractRtfText(_wsDataUrlToBytes(content));
    else if(kind==='epub')text=await _wsExtractEpubText(_wsDataUrlToBytes(content));
  }catch(e){text=(e&&e._wsLibMsg)||''}
  text=String(text||'').trim()||'[无法提取文本内容]';
  if(!_wsRichEnvFail(text)){/* 环境性失败不缓存：用户开启开关或恢复联网后，同一文件重试即可正常提取 */
    _wsRichTextCache[key]=text;_wsRichTextCacheKeys.push(key);
    if(_wsRichTextCacheKeys.length>6)delete _wsRichTextCache[_wsRichTextCacheKeys.shift()];
  }
  return text;
}
/* PDF：带密码缓存的提取；无文字层（扫描件）时给出明确出路 */
var _wsPdfPwCache={};
async function _wsExtractPdfText(f){
  var lib;
  try{lib=await _wsLoadPdfJs()}catch(e){return (e&&e._wsLibMsg)||'[PDF 解析库未就绪：请在 DIY 页开启「文件解析库」后重试]'}
  var pw=_wsPdfPwCache[f&&f.id];
  var doc;
  try{doc=await lib.getDocument(Object.assign({data:_wsDataUrlToBytes(f.content)},pw?{password:pw}:{})).promise}
  catch(e){
    if(e&&e.name==='PasswordException')return'[该 PDF 已加密：请先在 ICode 预览中打开它并输入密码，之后即可正常读取]';
    return'[PDF 解析失败：文件可能已损坏]';
  }
  var pages=[];
  try{
    for(var n=1;n<=doc.numPages;n++){
      var tc=await(await doc.getPage(n)).getTextContent();
      var line='';
      for(var i=0;i<tc.items.length;i++){var it=tc.items[i];line+=(it.str||'')+(it.hasEOL?'\n':' ')}
      pages.push(line.replace(/[ \t]+\n/g,'\n').trim());
    }
  }finally{try{doc.destroy()}catch(e){}}
  var joined=pages.join('\n\n');
  if(joined.replace(/\s+/g,'').length<Math.max(20,doc.numPages*2))
    return'[该 PDF 没有可提取的文字层，可能是扫描件。请让用户在 ICode 预览中用「以图片发送」把页面发给支持图像的模型]';
  return joined;
}
/* DOCX：mammoth 优先；被拒收（WPS 旧版 / 转换器产物等 */
async function _wsExtractDocxText(dataUrl){
  var bytes=_wsDataUrlToBytes(dataUrl);
  try{
    await _wsLoadScript(_WS_RICH_CDN.mammoth,'DOCX');
    var r=await window.mammoth.extractRawText({arrayBuffer:bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)});
    var v=r&&r.value||'';
    if(v.trim())return v;
  }catch(e){if(e&&e._wsLibMsg)throw e}
  try{return await _wsDocxXmlText(bytes)}
  catch(e2){return'[无法解析该 DOCX：文件可能已损坏，或是被改扩展名的老式 .doc（请用 Word/WPS 另存为 .docx 后重新导入）]'}
}
async function _wsDocxXmlText(bytes){
  var ents=_wsZipList(bytes);
  var docEnt=null;
  for(var i=0;i<ents.length;i++)if(ents[i].name==='word/document.xml'){docEnt=ents[i];break}
  if(!docEnt)throw new Error('缺少 word/document.xml');
  var xml=new TextDecoder('utf-8').decode(await _wsZipRead(bytes,docEnt));
  var t=xml
    .replace(/<w:tab[^>]*\/?>/g,'\t')
    .replace(/<w:br[^>]*\/?>/g,'\n')
    .replace(/<\/w:p>/g,'\n')
    .replace(/<[^>]+>/g,'');
  var out=_wsXmlUnescape(t).replace(/\n{3,}/g,'\n\n').trim();
  if(!out)throw new Error('正文为空');
  return out;
}
/* XLSX / XLS：SheetJS 同时支持两种格式 */
async function _wsExtractXlsxText(dataUrl){
  await _wsLoadScript(_WS_RICH_CDN.xlsx,'XLSX');
  var wb=window.XLSX.read(_wsDataUrlToBytes(dataUrl),{type:'array'});
  var names=wb.SheetNames||[],parts=[];
  for(var i=0;i<names.length;i++){
    var csv=window.XLSX.utils.sheet_to_csv(wb.Sheets[names[i]]);
    parts.push(names.length>1?('['+names[i]+']\n'+csv):csv);
  }
  return parts.join('\n\n');
}
/* PPTX：内置 ZIP 读取器抽各页 <a:t> 文本，零新增依赖 */
async function _wsExtractPptxText(bytes){
  var ents=_wsZipList(bytes);
  var slides=ents.filter(function(e){return /^ppt\/slides\/slide\d+\.xml$/i.test(e.name)});
  if(!slides.length)return'[该 PPTX 中没有可提取的幻灯片文本]';
  slides.sort(function(a,b){return parseInt(a.name.match(/(\d+)\.xml$/i)[1],10)-parseInt(b.name.match(/(\d+)\.xml$/i)[1],10)});
  var parts=[];
  for(var i=0;i<slides.length;i++){
    var xml=new TextDecoder('utf-8').decode(await _wsZipRead(bytes,slides[i]));
    var texts=[];
    xml.replace(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g,function(mm,t){texts.push(_wsXmlUnescape(t));return mm});
    parts.push('【第 '+(i+1)+' 页】\n'+texts.join('\n').trim());
  }
  return parts.join('\n\n');
}
/* RTF：内置剥离器。\'hh 字节按 \ansicpg 声明的代码页解码（中文 RTF 常见 936/GBK），
   \uN 按 Unicode 码位还原并跳过后备字符 */
async function _wsExtractRtfText(bytes){
  var src='';
  for(var i0=0;i0<bytes.length;i0+=0x8000)src+=String.fromCharCode.apply(null,bytes.subarray(i0,i0+0x8000));
  var cpm={936:'gbk',950:'big5',932:'shift_jis',949:'euc-kr',1252:'windows-1252',65001:'utf-8'};
  var cpg=(src.match(/\\ansicpg(\d+)/)||[])[1];
  var dec;try{dec=new TextDecoder(cpm[parseInt(cpg,10)]||'gbk')}catch(e){dec=new TextDecoder('utf-8')}
  var out='',i=0,n=src.length,uc=1,hexRun=[];
  function flushHex(){if(hexRun.length){try{out+=dec.decode(new Uint8Array(hexRun))}catch(e){}hexRun=[]}}
  while(i<n){
    var ch=src[i];
    if(ch==='{'||ch==='}'){flushHex();i++;
      if(ch==='{'&&src.substr(i,2)==='\\*'){/* 跳过整个扩展目标组 */
        var depth=1;i+=2;
        while(i<n&&depth>0){if(src[i]==='{')depth++;else if(src[i]==='}')depth--;else if(src[i]==='\\')i++;i++}
      }
      continue;
    }
    if(ch!=='\\'){
      flushHex();
      if(ch!=='\r'&&ch!=='\n')out+=ch;
      i++;continue;
    }
    /* 控制符 */
    var m=/^\\'([0-9a-fA-F]{2})/.exec(src.slice(i,i+4));
    if(m){hexRun.push(parseInt(m[1],16));i+=4;continue}
    flushHex();
    var mw=/^\\([a-zA-Z]+)(-?\d+)? ?/.exec(src.slice(i,i+32));
    if(mw){
      var w=mw[1],num=mw[2]!==undefined?parseInt(mw[2],10):null;
      i+=mw[0].length;
      if(w==='par'||w==='line'||w==='sect'||w==='page')out+='\n';
      else if(w==='tab')out+='\t';
      else if(w==='uc'&&num!==null)uc=num;
      else if(w==='u'&&num!==null){
        var code=num<0?num+65536:num;
        try{out+=String.fromCodePoint(code)}catch(e){}
        for(var s2=0;s2<uc&&i<n;s2++){/* 跳过后备字符（可能是 \'hh 或普通字符） */
          var fm=/^\\'([0-9a-fA-F]{2})/.exec(src.slice(i,i+4));
          if(fm)i+=4;else i++;
        }
      }else if(w==='bin'&&num!==null){i+=Math.max(0,num)}
      /* 其余控制词（字体、颜色、样式表等）直接忽略 */
      continue;
    }
    /* \\ \{ \} 等转义符 */
    var esc2=src[i+1];
    if(esc2==='\\'||esc2==='{'||esc2==='}'){out+=esc2;i+=2;continue}
    if(esc2==='~'){out+=' ';i+=2;continue}
    i+=2;
  }
  flushHex();
  out=out.replace(/\n{3,}/g,'\n\n').trim();
  return out||'[该 RTF 中没有可提取的正文文本]';
}
/* EPUB：ZIP + XHTML。按 OPF 的 spine 顺序抽正文，解析失败时按文件名自然序兜底 */
async function _wsExtractEpubText(bytes){
  var ents=_wsZipList(bytes),byName={};
  ents.forEach(function(e){byName[e.name]=e});
  async function readTxt(en){return new TextDecoder('utf-8').decode(await _wsZipRead(bytes,en))}
  var order=[];
  try{
    var cont=byName['META-INF/container.xml'];
    var opfPath=null;
    if(cont){var cx=await readTxt(cont);var cm=cx.match(/full-path\s*=\s*"([^"]+)"/);if(cm)opfPath=cm[1]}
    if(opfPath&&byName[opfPath]){
      var opf=await readTxt(byName[opfPath]);
      var dir=opfPath.indexOf('/')>-1?opfPath.slice(0,opfPath.lastIndexOf('/')+1):'';
      var items={};
      opf.replace(/<item\s+[^>]*>/gi,function(tag){
        var id=(tag.match(/\bid\s*=\s*"([^"]+)"/)||[])[1],href=(tag.match(/\bhref\s*=\s*"([^"]+)"/)||[])[1];
        if(id&&href)items[id]=href;return tag;
      });
      opf.replace(/<itemref\s+[^>]*>/gi,function(tag){
        var idr=(tag.match(/\bidref\s*=\s*"([^"]+)"/)||[])[1];
        if(idr&&items[idr]){var p=dir+decodeURIComponent(items[idr]);if(byName[p])order.push(byName[p])}
        return tag;
      });
    }
  }catch(e){}
  if(!order.length){
    order=ents.filter(function(e){return /\.x?html?$/i.test(e.name)});
    order.sort(function(a,b){return a.name<b.name?-1:(a.name>b.name?1:0)});
  }
  if(!order.length)return'[该 EPUB 中没有可提取的章节内容]';
  var out='',CAP=3000000;
  for(var i=0;i<order.length&&out.length<CAP;i++){
    var h;try{h=await readTxt(order[i])}catch(e){continue}
    var t=h
      .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi,'')
      .replace(/<\/(p|div|h[1-6]|li|tr|section|article|blockquote)\s*>/gi,'\n')
      .replace(/<br[^>]*\/?>/gi,'\n')
      .replace(/<[^>]+>/g,'');
    out+=(out?'\n\n':'')+_wsXmlUnescape(t).replace(/\n{3,}/g,'\n\n').trim();
  }
  if(out.length>=CAP)out=out.slice(0,CAP)+'\n[…EPUB 内容超过提取上限（300 万字符），已截断]';
  return out;
}
/* ── PDF 密码：预览侧交互解锁，成功后写入会话密码缓存并清掉旧的提取缓存，
   之后 ws_read / 附件提取自动生效 ── */
function _wsPromptPdfPassword(f,wrong){
  return new Promise(function(resolve){
    var host=document.getElementById('ws-overlay')||document.body;
    var mask=document.createElement('div');mask.className='ws-dialog-mask';
    var d=document.createElement('div');d.className='ws-dialog';
    d.innerHTML='<h4>PDF 已加密</h4>'
      +'<p>「'+esc(String(f.path||'').split('/').pop())+'」需要密码才能打开。'+(wrong?'<br><b>密码不正确，请重试。</b>':'')+'</p>'
      +'<input type="password" class="ws-dialog-input" id="ws-pdfpw-inp" placeholder="输入 PDF 密码" style="width:100%;box-sizing:border-box;margin:6px 0 2px;padding:7px 10px">'
      +'<div class="ws-dialog-actions"><button class="ws-file-btn" data-act="cancel">取消</button><button class="ws-file-btn primary" data-act="ok">解锁</button></div>';
    mask.appendChild(d);host.appendChild(mask);
    var inp=d.querySelector('#ws-pdfpw-inp');
    var done=function(v){mask.remove();resolve(v)};
    mask.addEventListener('mousedown',function(e){if(e.target===mask)done(null)});
    d.querySelector('[data-act="cancel"]').onclick=function(){done(null)};
    d.querySelector('[data-act="ok"]').onclick=function(){done(inp.value||'')};
    inp.addEventListener('keydown',function(e){if(e.key==='Enter')done(inp.value||'')});
    setTimeout(function(){try{inp.focus()}catch(e){}},50);
  });
}
/* 交互式打开 PDF：库未就绪/损坏 → 抛带 _wsMsg 的错误；受 */
async function _wsPdfEnsureOpen(f,opts){
  opts=opts||{};
  var stage=opts.onStage||function(){};
  stage('正在加载 PDF 解析库…');
  var lib;
  try{lib=await _wsLoadPdfJs()}
  catch(e){var er=new Error('lib');er._wsMsg=(e&&e._wsLibMsg?e._wsLibMsg.replace(/^\[|\]$/g,''):'PDF 解析库未就绪：请在 DIY 页开启「文件解析库」后重试');throw er}
  var wrong=false;
  for(;;){
    stage('正在解析 PDF…');
    var pw=_wsPdfPwCache[f.id];
    try{return await lib.getDocument(Object.assign({data:_wsDataUrlToBytes(f.content)},pw?{password:pw}:{})).promise}
    catch(e){
      if(e&&e.name==='PasswordException'){
        if(!opts.interactive){var er2=new Error('pw');er2._wsMsg='该 PDF 已加密';throw er2}
        var input=await _wsPromptPdfPassword(f,wrong);
        if(input===null)return null;
        _wsPdfPwCache[f.id]=input;wrong=true;_wsRichCacheDrop(f);
        continue;
      }
      var er3=new Error('parse');er3._wsMsg='PDF 解析失败：文件可能已损坏';throw er3;
    }
  }
}
async function wsTogglePreview(fileId){
  var existing=document.getElementById('wsp-'+fileId);
  if(existing){existing.remove();return}
  var f=null;try{f=await dbGet('projectFiles',fileId)}catch(e){}
  if(!f)return;
  var row=document.getElementById('wsf-'+fileId);if(!row)return;
  if(_icodeIsRich(f.path)){_wsOpenRichPreview(fileId,f,row);return}/* 富文件走独立预览 */
  var preview=document.createElement('div');preview.className='ws-preview';preview.id='wsp-'+fileId;
  var lines=f.content.split('\n');
  var numbered=lines.map(function(l,i){return String(i+1).padStart(4,' ')+'  '+l}).join('\n');
  var isHtml=/\.html?$/i.test(f.path||'');
  preview.innerHTML='<div class="ws-preview-head"><span class="ws-preview-name">'+esc(f.path)+'</span>'
    +'<div class="ws-preview-acts">'
    +'<button class="ws-file-btn" title="搜索定位" onclick="wsToggleSearch(\''+fileId+'\')">'+_WS_SEARCH_SVG+'</button>'
    +(isHtml?'<button class="ws-file-btn" data-wsact="render" onclick="wsToggleRenderPreview(\''+fileId+'\')">渲染</button>':'')
    +'<button class="ws-file-btn" onclick="wsEditInPreview(\''+fileId+'\')">编辑</button>'
    +'<button class="ws-file-btn" onclick="this.closest(\'.ws-preview\').remove()">关闭</button>'
    +'</div></div>'
    +'<div class="ws-preview-code"></div>';
  preview.querySelector('.ws-preview-code').textContent=numbered;
  row.after(preview);
}
/* ── 富文件预览面板 ────────────────────
   头部：格式徽标 + 专属按钮（PDF：以图片发送 / DOCX：提取图片）+ 搜索
   （作用于提取文本）+ 渲染/文本视图切换 + 关闭。无编辑按钮（富文件不支持就地编辑）。
   PPTX / RTF / EPUB 无排版渲染视图，直接展示提取文本。 */
function _wsOpenRichPreview(fileId,f,row){
  var preview=document.createElement('div');preview.className='ws-preview';preview.id='wsp-'+fileId;
  var kind=_wsRichKind(f.path);
  var textOnly=/^(pptx|rtf|epub)$/.test(kind);
  preview.innerHTML='<div class="ws-preview-head"><span class="ws-preview-name">'+esc(f.path)+'</span>'
    +'<div class="ws-preview-acts">'
    +'<span class="ws-rich-badge" id="wsrb-'+fileId+'">'+kind.toUpperCase()+'</span>'
    +(kind==='pdf'?'<button class="ws-file-btn" title="把页面转成图片附加到聊天（需支持图像的模型）" onclick="wsPdfPagesToChat(\''+fileId+'\')">以图片发送</button>':'')
    +(kind==='docx'?'<button class="ws-file-btn" title="抽取文档内嵌图片附加到聊天（需支持图像的模型）" onclick="wsDocxImagesToChat(\''+fileId+'\')">提取图片</button>':'')
    +'<button class="ws-file-btn" title="搜索提取文本" onclick="wsRichSearch(\''+fileId+'\')">'+_WS_SEARCH_SVG+'</button>'
    +(textOnly?'':'<button class="ws-file-btn" data-wsact="richview" onclick="wsRichToggleView(\''+fileId+'\')">文本</button>')
    +'<button class="ws-file-btn" onclick="this.closest(\'.ws-preview\').remove()">关闭</button>'
    +'</div></div>'
    +'<div class="ws-preview-code" style="display:'+(textOnly?'':'none')+'"></div>'
    +'<div class="ws-rich-view"'+(textOnly?' style="display:none"':'')+'></div>';
  row.after(preview);
  if(textOnly)_wsRichLoadTextInto(preview.querySelector('.ws-preview-code'),fileId);
  else _wsRenderRichView(fileId,f,preview.querySelector('.ws-rich-view'));
}
function _wsRenderRichView(fileId,f,view){
  var kind=_wsRichKind(f.path);
  if(kind==='pdf')_wsRenderPdfPreview(fileId,f,view);
  else _wsRenderDocPreview(fileId,f,view,kind);
}
/* PDF：canvas 逐页渲染。首批最多 30 页，其余点按钮续载；
   每页渲染前检查面板是否已被关闭，关闭即释放文档对象 */
async function _wsRenderPdfPreview(fileId,f,view){
  view.innerHTML='<div class="ws-rich-loading">正在加载 PDF 解析库…</div>';
  var doc;
  try{doc=await _wsPdfEnsureOpen(f,{interactive:true,onStage:function(st){if(view.isConnected)view.innerHTML='<div class="ws-rich-loading">'+st+'</div>'}})}
  catch(e){if(view.isConnected)view.innerHTML='<div class="ws-rich-loading">'+esc(e&&e._wsMsg||'PDF 解析失败：文件可能已损坏')+'</div>';return}
  if(!doc){if(view.isConnected)view.innerHTML='<div class="ws-rich-loading">已取消：该 PDF 受密码保护</div>';return}
  if(!view.isConnected){try{doc.destroy()}catch(e){}return}
  if(!view.isConnected){try{doc.destroy()}catch(e){}return}
  var badge=document.getElementById('wsrb-'+fileId);
  if(badge)badge.textContent='PDF · '+doc.numPages+' 页';
  view.innerHTML='';
  var holder=view.closest('.ws-preview');
  var cw=Math.max(200,(holder?holder.clientWidth:600)-28);
  var dpr=Math.min(window.devicePixelRatio||1,2);
  async function renderRange(from,to){
    for(var n=from;n<=to;n++){
      if(!view.isConnected){try{doc.destroy()}catch(e){}return false}
      var page=await doc.getPage(n);
      var vp1=page.getViewport({scale:1});
      var scale=Math.min(cw/vp1.width,2);
      var vp=page.getViewport({scale:scale*dpr});
      var canvas=document.createElement('canvas');
      canvas.className='ws-pdf-page';
      canvas.width=vp.width;canvas.height=vp.height;
      canvas.style.width=Math.floor(vp.width/dpr)+'px';
      view.appendChild(canvas);
      await page.render({canvasContext:canvas.getContext('2d'),viewport:vp}).promise;
    }
    return true;
  }
  var first=Math.min(30,doc.numPages);
  if(!await renderRange(1,first))return;
  if(doc.numPages>first){
    var more=document.createElement('button');
    more.className='ws-file-btn ws-rich-more';
    more.textContent='加载剩余 '+(doc.numPages-first)+' 页';
    more.onclick=async function(){
      more.disabled=true;more.textContent='正在加载…';
      if(await renderRange(first+1,doc.numPages)){more.remove();try{doc.destroy()}catch(e){}}
    };
    view.appendChild(more);
  }else{try{doc.destroy()}catch(e){}}
}
/* DOCX / XLSX：转 HTML 后放入零权限 sandbox iframe 呈现 */
var _WS_RICH_DOC_CSS='body{margin:0;padding:14px 16px;background:#fff;color:#1b2637;font:14px/1.65 system-ui,-apple-system,"Segoe UI","Noto Sans SC",sans-serif;word-break:break-word}img{max-width:100%;height:auto}h3.ws-sheet-title{margin:18px 0 8px;font-size:13px;color:#6b7a90;font-weight:600}table{border-collapse:collapse;margin:8px 0;max-width:100%}td,th{border:1px solid #c9d5e8;padding:4px 8px;font-size:13px;vertical-align:top}th{background:#eef3fa}';
async function _wsRenderDocPreview(fileId,f,view,kind){
  var label=kind==='docx'?'DOCX':(kind==='xls'?'XLS':'XLSX');
  view.innerHTML='<div class="ws-rich-loading">正在加载 '+label+' 解析库…</div>';
  var body='',note='';
  try{
    if(kind==='docx'){
      var docxBytes=_wsDataUrlToBytes(f.content);
      try{
        await _wsLoadScript(_WS_RICH_CDN.mammoth,'DOCX');
        if(!view.isConnected)return;
        view.innerHTML='<div class="ws-rich-loading">正在解析文档…</div>';
        var r=await window.mammoth.convertToHtml({arrayBuffer:docxBytes.buffer});
        body=r&&r.value||'';
      }catch(eM){
        if(eM&&eM._wsLibMsg)throw eM;/* 库未就绪属硬失败，不走兜底 */
        body='';
      }
      if(!body.trim()){/* mammoth 拒收或产出为空 → 内置 ZIP 读取器抽正文文字兜底 */
        var fbTxt=await _wsDocxXmlText(docxBytes);
        body='<pre style="white-space:pre-wrap;margin:0;font:13px/1.7 inherit">'+esc(fbTxt)+'</pre>';
        note='<div style="padding:6px 10px;margin-bottom:8px;font-size:12px;color:#8a6d3b;background:#fff7e0;border:1px solid #f0e0b0;border-radius:4px">该文档无法按排版渲染（可能由旧版软件或格式转换器生成），已改为显示提取文本。</div>';
      }
    }else{
      await _wsLoadScript(_WS_RICH_CDN.xlsx,'XLSX');
      if(!view.isConnected)return;
      view.innerHTML='<div class="ws-rich-loading">正在解析表格…</div>';
      var wb=window.XLSX.read(_wsDataUrlToBytes(f.content),{type:'array'});
      var names=wb.SheetNames||[],parts=[];
      for(var i=0;i<names.length;i++){
        var html=window.XLSX.utils.sheet_to_html(wb.Sheets[names[i]],{header:'',footer:''});
        parts.push((names.length>1?'<h3 class="ws-sheet-title">'+esc(names[i])+'</h3>':'')+html);
      }
      body=parts.join('');
      var badge=document.getElementById('wsrb-'+fileId);
      if(badge)badge.textContent=label+' · '+names.length+' 表';
    }
  }catch(e){
    var lm=e&&e._wsLibMsg?e._wsLibMsg.replace(/^\[|\]$/g,''):null;
    if(view.isConnected)view.innerHTML='<div class="ws-rich-loading">'+esc(lm||(label+' 预览失败：文件无法解析或已损坏'+(kind==='docx'?'（若为老式 .doc 请在 Word/WPS 中另存为 .docx）':'')))+'</div>';
    return;
  }
  if(!view.isConnected)return;
  view.innerHTML='';
  var frame=document.createElement('iframe');
  frame.className='ws-rich-frame';
  frame.setAttribute('sandbox','');
  frame.setAttribute('referrerpolicy','no-referrer');
  frame.srcdoc='<!DOCTYPE html><html><head><meta charset="utf-8"><style>'+_WS_RICH_DOC_CSS+'</style></head><body>'+note+body+'</body></html>';
  view.appendChild(frame);
}
/* 渲染视图 ⇄ 提取文本视图切换；文本首次进入时提取并加行号 */
async function wsRichToggleView(fileId){
  var preview=document.getElementById('wsp-'+fileId);if(!preview)return;
  var view=preview.querySelector('.ws-rich-view');
  var code=preview.querySelector('.ws-preview-code');
  var btn=preview.querySelector('[data-wsact="richview"]');
  if(!view||!code)return;
  if(code.style.display==='none'){
    view.style.display='none';code.style.display='';
    if(btn)btn.textContent='渲染';
    await _wsRichLoadTextInto(code,fileId);
  }else{
    wsSearchClose(fileId);
    code.style.display='none';view.style.display='';
    if(btn)btn.textContent='文本';
  }
}
/* 富文件搜索入口：先切到提取文本视图，再复用既有搜索条 */
async function wsRichSearch(fileId){
  var preview=document.getElementById('wsp-'+fileId);if(!preview)return;
  var code=preview.querySelector('.ws-preview-code');
  if(code&&code.style.display==='none')await wsRichToggleView(fileId);
  wsToggleSearch(fileId);
}
/* ── ICode 内文搜索 ── */
var _WS_SEARCH_SVG='<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="7" cy="7" r="4.2"/><path d="M13.2 13.2l-3.1-3.1"/></svg>';
function wsToggleSearch(fileId){
  var preview=document.getElementById('wsp-'+fileId);if(!preview)return;
  var bar=preview.querySelector('.ws-search-bar');
  if(bar){wsSearchClose(fileId);return}
  bar=document.createElement('div');bar.className='ws-search-bar';
  bar.innerHTML='<input type="text" placeholder="搜索文本… Enter 下一个 / Shift+Enter 上一个" spellcheck="false">'
    +'<span class="ws-search-count">0/0</span>'
    +'<button class="ws-file-btn" data-a="prev" title="上一个">↑</button>'
    +'<button class="ws-file-btn" data-a="next" title="下一个">↓</button>'
    +'<button class="ws-file-btn" data-a="close" title="关闭搜索">✕</button>';
  var head=preview.querySelector('.ws-preview-head');
  head.after(bar);
  var inp=bar.querySelector('input');
  inp.addEventListener('input',function(){wsSearchRun(fileId,0)});
  inp.addEventListener('keydown',function(e){
    if(e.key==='Enter'){e.preventDefault();wsSearchRun(fileId,e.shiftKey?-1:1)}
    if(e.key==='Escape'){e.preventDefault();wsSearchClose(fileId)}
  });
  bar.querySelector('[data-a="prev"]').onclick=function(){wsSearchRun(fileId,-1)};
  bar.querySelector('[data-a="next"]').onclick=function(){wsSearchRun(fileId,1)};
  bar.querySelector('[data-a="close"]').onclick=function(){wsSearchClose(fileId)};
  preview._searchIdx=-1;
  inp.focus();
}
function wsSearchClose(fileId){
  var preview=document.getElementById('wsp-'+fileId);if(!preview)return;
  var bar=preview.querySelector('.ws-search-bar');if(bar)bar.remove();
  var code=preview.querySelector('.ws-preview-code');
  if(code&&code._rawText!==undefined)code.textContent=code._rawText;/* 还原纯文本，去掉高亮 */
  preview._searchIdx=-1;
}
function wsSearchRun(fileId,dir){
  var preview=document.getElementById('wsp-'+fileId);if(!preview)return;
  var bar=preview.querySelector('.ws-search-bar');if(!bar)return;
  var q=bar.querySelector('input').value;
  var cntEl=bar.querySelector('.ws-search-count');
  var ta=preview.querySelector('.ws-edit-area');
  var code=preview.querySelector('.ws-preview-code');
  if(!ta&&preview.querySelector('.ws-render-frame')){cntEl.textContent='—';toast('渲染模式下无法搜索，请先切回代码视图');return}
  if(!ta&&code&&code._rawText===undefined)code._rawText=code.textContent;/* 首次搜索时缓存原文 */
  var hay=ta?ta.value:(code?code._rawText:'');
  if(!q){cntEl.textContent='0/0';if(!ta&&code)code.textContent=hay;preview._searchIdx=-1;return}
  /* 收集所有命中位置（不区分大小写，按查询长度步进避免重叠） */
  var pos=[],lq=q.toLowerCase(),lh=hay.toLowerCase(),i=lh.indexOf(lq);
  while(i!==-1){pos.push(i);i=lh.indexOf(lq,i+q.length)}
  if(!pos.length){cntEl.textContent='0/0';if(!ta&&code)code.textContent=hay;preview._searchIdx=-1;return}
  var idx=typeof preview._searchIdx==='number'?preview._searchIdx:-1;
  if(dir===0)idx=0;else{idx+=dir;if(idx<0)idx=pos.length-1;if(idx>=pos.length)idx=0}
  preview._searchIdx=idx;
  cntEl.textContent=(idx+1)+'/'+pos.length;
  if(ta){/* 编辑模式：选中命中并滚动到对应行（行号栏同步） */
    ta.focus();ta.setSelectionRange(pos[idx],pos[idx]+q.length);
    var line=hay.slice(0,pos[idx]).split('\n').length-1;
    var lh2=parseFloat(getComputedStyle(ta).lineHeight)||18;
    ta.scrollTop=Math.max(0,line*lh2-ta.clientHeight/2);
  }else if(code){/* 预览模式：重建高亮并只滚动预览容器（不滚动页面） */
    var html='',last=0;
    for(var k=0;k<pos.length;k++){
      html+=esc(hay.slice(last,pos[k]))+'<mark class="ws-hit'+(k===idx?' cur':'')+'">'+esc(hay.substr(pos[k],q.length))+'</mark>';
      last=pos[k]+q.length;
    }
    html+=esc(hay.slice(last));
    code.innerHTML=html;
    var cur=code.querySelector('.ws-hit.cur');
    if(cur)code.scrollTop=Math.max(0,cur.offsetTop-code.clientHeight/2);
  }
}
/* ── 预览内联编辑：预览区换成同款等宽编辑框，保存即覆盖原文件（用户手动改原文件属于「有意覆盖」）── */
async function wsEditInPreview(fileId){
  var preview=document.getElementById('wsp-'+fileId);if(!preview)return;
  if(preview.querySelector('.ws-edit-area'))return;/* 已在编辑中 */
  var f=null;try{f=await dbGet('projectFiles',fileId)}catch(e){}
  if(!f){toast('文件不存在');return}
  var code=preview.querySelector('.ws-preview-code');
  var acts=preview.querySelector('.ws-preview-acts');
  if(!code||!acts)return;
  /* 若正处于「渲染」模式，先退回代码视图再进入编辑：渲染与编辑互斥。
     须在捕获 prevActs 之前复位按钮文案，取消编辑后按钮才会还原成「渲染」。 */
  var rframe=preview.querySelector('.ws-render-frame');
  if(rframe){rframe.remove();code.style.display='';var rbtn=preview.querySelector('[data-wsact="render"]');if(rbtn)rbtn.textContent='渲染'}
  var ta=document.createElement('textarea');ta.className='ws-edit-area';ta.value=f.content;ta.spellcheck=false;
  ta.addEventListener('keydown',function(e){/* Tab 输入两个空格而不是移焦 */
    if(e.key!=='Tab')return;e.preventDefault();
    var s=ta.selectionStart,en=ta.selectionEnd;
    ta.value=ta.value.slice(0,s)+'  '+ta.value.slice(en);
    ta.selectionStart=ta.selectionEnd=s+2;
  });
  code.style.display='none';
  preview.insertBefore(ta,code);
  var prevActs=acts.innerHTML;
  acts.innerHTML='<button class="ws-file-btn" title="搜索定位" data-a="search">'+_WS_SEARCH_SVG+'</button>'
    +'<button class="ws-file-btn primary" data-a="save">保存</button><button class="ws-file-btn" data-a="cancel">取消</button>';
  acts.querySelector('[data-a="search"]').onclick=function(){wsToggleSearch(fileId)};
  acts.querySelector('[data-a="cancel"]').onclick=function(){ta.remove();code.style.display='';acts.innerHTML=prevActs;var sb=preview.querySelector('.ws-search-bar');if(sb)wsSearchClose(fileId)};
  acts.querySelector('[data-a="save"]').onclick=async function(){
    this.disabled=true;this.textContent='保存中…';
    try{
      await wsSaveFile(f.projectId,f.path,ta.value,'User');
      toast('已保存');
      await renderWsFiles(f.projectId);/* 刷新大小/时间等元信息 */
      wsTogglePreview(fileId);/* 用最新内容重新展开预览 */
    }catch(e){toast('保存失败：'+String(e&&e.message||e).slice(0,60));this.disabled=false;this.textContent='保存'}
  };
  ta.focus();
}
/* ── HTML 渲染预览：预览面板内「渲染 ⇄ 代码」一键切换 ──
   iframe 用 sandbox（不含 allow-same-origin）隔离：页面里的脚本可以跑，
   但拿不到 IB 的存储与 DOM。与编辑互斥：进入编辑时自动退回代码视图。 */
async function wsToggleRenderPreview(fileId){
  var preview=document.getElementById('wsp-'+fileId);if(!preview)return;
  if(preview.querySelector('.ws-edit-area')){toast('正在编辑中，请先保存或取消再切换渲染');return}
  var code=preview.querySelector('.ws-preview-code');
  var btn=preview.querySelector('[data-wsact="render"]');
  var frame=preview.querySelector('.ws-render-frame');
  if(frame){frame.remove();if(code)code.style.display='';if(btn)btn.textContent='渲染';return}
  var f=null;try{f=await dbGet('projectFiles',fileId)}catch(e){}
  if(!f){toast('文件不存在');return}
  frame=document.createElement('iframe');
  frame.className='ws-render-frame';
  frame.setAttribute('sandbox','allow-scripts allow-forms allow-modals allow-popups');
  frame.setAttribute('referrerpolicy','no-referrer');
  frame.srcdoc=f.content;
  if(code)code.style.display='none';
  preview.insertBefore(frame,code);
  if(btn)btn.textContent='代码';
}

/* ---- 双挂载：communication.js（pickFile 富文件提取）与 local-first.js（清库）的运行时调用、预览面板内联 onclick 模板串仍经 window 访问；IB.workspace.preview 登记导出 ---- */
function ibWsPreviewLive(name, getter, setter){
  Object.defineProperty(window, name, { get: getter, set: setter, configurable: true });
}
window._icodeLooksBinary=_icodeLooksBinary;
window._icodeSniffText=_icodeSniffText;
window._icodeIsRich=_icodeIsRich;
window._wsRichKind=_wsRichKind;
window._wsRichMime=_wsRichMime;
window._ibRichLibsOn=_ibRichLibsOn;
window._ibLibDb=_ibLibDb;
window._ibLibGet=_ibLibGet;
window._ibLibPut=_ibLibPut;
window._ibLibClear=_ibLibClear;
window._wsLibErr=_wsLibErr;
window._wsFetchLibText=_wsFetchLibText;
window._wsLoadScript=_wsLoadScript;
window._wsLoadPdfJs=_wsLoadPdfJs;
window._wsBytesToDataUrl=_wsBytesToDataUrl;
window._wsFileToDataUrl=_wsFileToDataUrl;
window._wsDataUrlToBytes=_wsDataUrlToBytes;
window._wsBase64ToBlob=_wsBase64ToBlob;
window._wsZipList=_wsZipList;
window._wsZipRead=_wsZipRead;
window._wsXmlUnescape=_wsXmlUnescape;
window._wsRichCacheKey=_wsRichCacheKey;
window._wsRichCacheDrop=_wsRichCacheDrop;
window._wsRichIsFailText=_wsRichIsFailText;
window._wsRichEnvFail=_wsRichEnvFail;
window._wsExtractRichText=_wsExtractRichText;
window._wsExtractPdfText=_wsExtractPdfText;
window._wsExtractDocxText=_wsExtractDocxText;
window._wsDocxXmlText=_wsDocxXmlText;
window._wsExtractXlsxText=_wsExtractXlsxText;
window._wsExtractPptxText=_wsExtractPptxText;
window._wsExtractRtfText=_wsExtractRtfText;
window._wsExtractEpubText=_wsExtractEpubText;
window._wsPromptPdfPassword=_wsPromptPdfPassword;
window._wsPdfEnsureOpen=_wsPdfEnsureOpen;
window.wsTogglePreview=wsTogglePreview;
window._wsOpenRichPreview=_wsOpenRichPreview;
window._wsRenderRichView=_wsRenderRichView;
window._wsRenderPdfPreview=_wsRenderPdfPreview;
window._wsRenderDocPreview=_wsRenderDocPreview;
window.wsRichToggleView=wsRichToggleView;
window.wsRichSearch=wsRichSearch;
window.wsToggleSearch=wsToggleSearch;
window.wsSearchClose=wsSearchClose;
window.wsSearchRun=wsSearchRun;
window.wsEditInPreview=wsEditInPreview;
window.wsToggleRenderPreview=wsToggleRenderPreview;
ibWsPreviewLive('_ICODE_RICH_EXT', function(){return _ICODE_RICH_EXT}, function(v){_ICODE_RICH_EXT=v});
ibWsPreviewLive('_WS_RICH_CDN', function(){return _WS_RICH_CDN}, function(v){_WS_RICH_CDN=v});
ibWsPreviewLive('_ibLibDbP', function(){return _ibLibDbP}, function(v){_ibLibDbP=v});
ibWsPreviewLive('_wsScriptCache', function(){return _wsScriptCache}, function(v){_wsScriptCache=v});
ibWsPreviewLive('_wsPdfLibPromise', function(){return _wsPdfLibPromise}, function(v){_wsPdfLibPromise=v});
ibWsPreviewLive('_wsRichTextCache', function(){return _wsRichTextCache}, function(v){_wsRichTextCache=v});
ibWsPreviewLive('_wsPdfPwCache', function(){return _wsPdfPwCache}, function(v){_wsPdfPwCache=v});
ibWsPreviewLive('_WS_RICH_DOC_CSS', function(){return _WS_RICH_DOC_CSS}, function(v){_WS_RICH_DOC_CSS=v});
ibWsPreviewLive('_WS_SEARCH_SVG', function(){return _WS_SEARCH_SVG}, function(v){_WS_SEARCH_SVG=v});
ibWsPreviewLive('_wsRichTextCacheKeys', function(){return _wsRichTextCacheKeys}, function(v){_wsRichTextCacheKeys=v});
NS.expose('workspace.preview', {
  _icodeLooksBinary: _icodeLooksBinary,
  _icodeSniffText: _icodeSniffText,
  _icodeIsRich: _icodeIsRich,
  _wsRichKind: _wsRichKind,
  _wsRichMime: _wsRichMime,
  _ibRichLibsOn: _ibRichLibsOn,
  _ibLibDb: _ibLibDb,
  _ibLibGet: _ibLibGet,
  _ibLibPut: _ibLibPut,
  _ibLibClear: _ibLibClear,
  _wsLibErr: _wsLibErr,
  _wsFetchLibText: _wsFetchLibText,
  _wsLoadScript: _wsLoadScript,
  _wsLoadPdfJs: _wsLoadPdfJs,
  _wsBytesToDataUrl: _wsBytesToDataUrl,
  _wsFileToDataUrl: _wsFileToDataUrl,
  _wsDataUrlToBytes: _wsDataUrlToBytes,
  _wsBase64ToBlob: _wsBase64ToBlob,
  _wsZipList: _wsZipList,
  _wsZipRead: _wsZipRead,
  _wsXmlUnescape: _wsXmlUnescape,
  _wsRichCacheKey: _wsRichCacheKey,
  _wsRichCacheDrop: _wsRichCacheDrop,
  _wsRichIsFailText: _wsRichIsFailText,
  _wsRichEnvFail: _wsRichEnvFail,
  _wsExtractRichText: _wsExtractRichText,
  _wsExtractPdfText: _wsExtractPdfText,
  _wsExtractDocxText: _wsExtractDocxText,
  _wsDocxXmlText: _wsDocxXmlText,
  _wsExtractXlsxText: _wsExtractXlsxText,
  _wsExtractPptxText: _wsExtractPptxText,
  _wsExtractRtfText: _wsExtractRtfText,
  _wsExtractEpubText: _wsExtractEpubText,
  _wsPromptPdfPassword: _wsPromptPdfPassword,
  _wsPdfEnsureOpen: _wsPdfEnsureOpen,
  wsTogglePreview: wsTogglePreview,
  _wsOpenRichPreview: _wsOpenRichPreview,
  _wsRenderRichView: _wsRenderRichView,
  _wsRenderPdfPreview: _wsRenderPdfPreview,
  _wsRenderDocPreview: _wsRenderDocPreview,
  wsRichToggleView: wsRichToggleView,
  wsRichSearch: wsRichSearch,
  wsToggleSearch: wsToggleSearch,
  wsSearchClose: wsSearchClose,
  wsSearchRun: wsSearchRun,
  wsEditInPreview: wsEditInPreview,
  wsToggleRenderPreview: wsToggleRenderPreview,
  _ICODE_RICH_EXT: _ICODE_RICH_EXT,
  _WS_RICH_CDN: _WS_RICH_CDN,
  _ibLibDbP: _ibLibDbP,
  _wsScriptCache: _wsScriptCache,
  _wsPdfLibPromise: _wsPdfLibPromise,
  _wsRichTextCache: _wsRichTextCache,
  _wsPdfPwCache: _wsPdfPwCache,
  _WS_RICH_DOC_CSS: _WS_RICH_DOC_CSS,
  _WS_SEARCH_SVG: _WS_SEARCH_SVG,
  _wsRichTextCacheKeys: _wsRichTextCacheKeys,
});
})(window.IB || (window.IB = {}));
