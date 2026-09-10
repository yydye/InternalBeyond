/* test_cache_audit.js — [IB Cache Audit] 前缀稳定性/首分歧 + baseline 身份隔离单元测试
   直接从生产文件 assets/js/communication.js 抽取自包含的缓存审计块（helpers + _ibCacheAudit）在沙箱内
   eval，测试的是实际交付的代码，而不是另一套重复实现。零依赖，node test_cache_audit.js 运行。
   覆盖：
     1-8   原有前缀稳定性 / 分段判定 / 截断脱敏 / 按格式分快照
     9-15  baseline 按请求身份隔离：同 consumer 比较、chat→diary 不互比、chat→diary→chat 仍比 chat A、
           同角色同 provider 同 model 不同 consumer 隔离、不同角色隔离、不同 provider/model 隔离、
           未声明 consumer 自成一档（绝不猜测）
     16-18 审计不修改请求体、日志身份字段、兼容别名 meta 透传 */
'use strict';
const fs=require('fs');
const path=require('path');

/* Repository root — this file lives in tests/, so the root is one level up. */
const ROOT = path.resolve(__dirname, '..');


const SRC=path.join(ROOT,'assets','js','communication.js');
const src=fs.readFileSync(SRC,'utf8');
const startMark='var _ibCacheAuditPrev={};';
const endMark='/* ── Anthropic 消息级缓存断点注入 ──';
const si=src.indexOf(startMark);
const ei=src.indexOf(endMark);
if(si<0||ei<0||ei<=si){
  console.error('无法从 communication.js 抽取缓存审计块（标记未找到）');
  process.exit(1);
}
const block=src.slice(si,ei);

function newSandbox(){
  const logs=[];/* {level, text} */
  const consoleStub={
    info:(...a)=>logs.push({level:'info',text:a.join(' ')}),
    warn:(...a)=>logs.push({level:'warn',text:a.join(' ')}),
    error:(...a)=>logs.push({level:'error',text:a.join(' ')}),
    log:(...a)=>logs.push({level:'log',text:a.join(' ')})
  };
  const vm=(new Function('console','Math','JSON','Array','String','Object','Number','RegExp','parseInt','parseFloat','isNaN',
    block+'; return {audit:typeof _ibCacheAudit==="function"?_ibCacheAudit:null, wrap: typeof _ibOaiCacheDiag==="function"?_ibOaiCacheDiag:null,'
      +' keyOf: typeof _ibCacheAuditKey==="function"?_ibCacheAuditKey:null, prev:_ibCacheAuditPrev};'
  ))(consoleStub,Math,JSON,Array,String,Object,Number,RegExp,parseInt,parseFloat,isNaN);
  return {audit:vm.audit,wrap:vm.wrap,keyOf:vm.keyOf,prev:vm.prev,logs,clear(){logs.length=0}};
}

let pass=0,fail=0;
function check(name,ok,detail){if(ok){pass++;console.log('  ✓ '+name)}else{fail++;console.log('  ✗ '+name+(detail?(' — '+detail):''))}}
function win(logs,re){return logs.filter(l=>re.test(l.text));}
function base(line){return win(line,/已记录本请求流基线/).length>0}
const M=consumer=>({consumer:consumer});

console.log('IB Cache Audit 单元测试\n');

/* ── 场景1：纯追加 → 前缀稳定 ── */
{
  const s=newSandbox();
  const cfg={id:'s1',provider:'custom',model:'m1'};
  const prevBody={model:'m1',messages:[{role:'system',content:'你是助手。'},{role:'user',content:'你好'}]};
  const curBody={model:'m1',messages:[{role:'system',content:'你是助手。'},{role:'user',content:'你好'},{role:'assistant',content:'嗨'},{role:'user',content:'今天天气'}]};
  s.audit(cfg,prevBody,'openai',M('chat'));s.clear();
  s.audit(cfg,curBody,'openai',M('chat'));
  const hit=win(s.logs,/Stable prefix.*纯追加/);
  check('纯追加 → 前缀完全稳定 (OpenAI)',hit.length>0&&/System: SAME \| History: SAME/.test(hit[0].text),hit[0]&&hit[0].text);
}

/* ── 场景2：system 变化 → 前缀提前分歧 ── */
{
  const s=newSandbox();
  const cfg={id:'s2',provider:'custom',model:'m2'};
  const prevBody={model:'m2',messages:[{role:'system',content:'A角色设定。'},{role:'user',content:'你好'}]};
  const curBody={model:'m2',messages:[{role:'system',content:'B角色设定。'},{role:'user',content:'你好'}]};
  s.audit(cfg,prevBody,'openai',M('chat'));s.clear();
  s.audit(cfg,curBody,'openai',M('chat'));
  const hit=win(s.logs,/First difference/);
  check('system 变化 → 判定改变',hit.length>0&&/System: CHANGED/.test(hit[0].text)&&/History: SAME/.test(hit[0].text),hit[0]&&hit[0].text);
  check('system 变化 → 首分歧段=SYS',hit.length>0&&/分歧段: SYS/.test(hit[0].text),hit[0]&&hit[0].text);
}

/* ── 场景3：历史中段变化（阶梯窗口回收前）→ History: CHANGED ── */
{
  const s=newSandbox();
  const cfg={id:'s3',provider:'custom',model:'m3'};
  const mk=(hist)=>({model:'m3',messages:[{role:'system',content:'S'},{role:'user',content:hist[0]},{role:'assistant',content:'A1'},{role:'user',content:hist[1]},{role:'assistant',content:'A2'},{role:'user',content:'最新'}]});
  s.audit(cfg,mk(['早','中']),'openai',M('chat'));s.clear();
  s.audit(cfg,mk(['早','改']),'openai',M('chat'));
  const hit=win(s.logs,/First difference/);
  check('历史消息变化 → History: CHANGED',hit.length>0&&/History: CHANGED/.test(hit[0].text)&&/System: SAME/.test(hit[0].text)&&/Request structure: SAME/.test(hit[0].text),hit[0]&&hit[0].text);
  check('历史变化 → 首分歧段=HIS',hit.length>0&&/分歧段: HIS/.test(hit[0].text),hit[0]&&hit[0].text);
}

/* ── 场景4：工具集变化 → Tools: CHANGED（OpenAI FC） ── */
{
  const s=newSandbox();
  const cfg={id:'s4',provider:'custom',model:'m4'};
  const tools=[{type:'function',function:{name:'f1',parameters:{type:'object'}}}];
  const mk=(t)=>({model:'m4',messages:[{role:'system',content:'S'},{role:'user',content:'hi'}],tools:t});
  s.audit(cfg,mk(tools),'openai',M('chat'));s.clear();
  s.audit(cfg,mk(null),'openai',M('chat'));
  const hit=win(s.logs,/First difference/);
  check('工具集变化 → Tools: CHANGED',hit.length>0&&/Tools: CHANGED/.test(hit[0].text),hit[0]&&hit[0].text);
}

/* ── 场景5：Anthropic 形态判定（system 数组 + 消息级断点） ── */
{
  const s=newSandbox();
  const cfg={id:'s5',provider:'anthropic',model:'m5'};
  const mk=(sys)=>({model:'m5',max_tokens:128,messages:[{role:'user',content:[{type:'text',text:'hi'}]},{role:'assistant',content:[{type:'text',text:'yo'}]},{role:'user',content:[{type:'text',text:'next'}]}],system:[{type:'text',text:sys}]});
  s.audit(cfg,mk('AnS'),'anthropic',M('chat'));s.clear();
  s.audit(cfg,mk('AnS2'),'anthropic',M('chat'));
  const hit=win(s.logs,/First difference/);
  check('Anthropic：system 数组变化 → System: CHANGED',hit.length>0&&/System: CHANGED/.test(hit[0].text),hit[0]&&hit[0].text);
}

/* ── 场景6：Gemini 形态判定（system_instruction） ── */
{
  const s=newSandbox();
  const cfg={id:'s6',provider:'gemini',model:'m6'};
  const mk=(sys)=>({model:'m6',contents:[{role:'user',parts:[{text:'hi'}]}],system_instruction:{parts:[{text:sys}]},generationConfig:{maxOutputTokens:64}});
  s.audit(cfg,mk('GS'),'gemini',M('chat'));s.clear();
  s.audit(cfg,mk('GS'),'gemini',M('chat'));/* 完全一致 → 纯追加/稳定 */
  s.clear();
  s.audit(cfg,mk('GS2'),'gemini',M('chat'));
  const hit=win(s.logs,/First difference/);
  check('Gemini：system_instruction 变化 → System: CHANGED',hit.length>0&&/System: CHANGED/.test(hit[0].text),hit[0]&&hit[0].text);
}

/* ── 场景7：变更片段为截断+脱敏输出（不泄露完整正文） ── */
{
  const s=newSandbox();
  const cfg={id:'s7',provider:'custom',model:'m7'};
  const long='X'.repeat(500);
  const prevBody={model:'m7',messages:[{role:'system',content:'S'},{role:'user',content:long+'.end'}]};
  const curBody={model:'m7',messages:[{role:'system',content:'S'},{role:'user',content:long+'.CHANGED'}]};
  s.audit(cfg,prevBody,'openai',M('chat'));s.clear();
  s.audit(cfg,curBody,'openai',M('chat'));
  const changed=win(s.logs,/Changed section/);
  check('变更片段只显示截断窗口',changed.length>0);
  if(changed.length){const frag=changed[0].text;const fullOccurs=(frag.match(/XXX/g)||[]).length;check('不打印完整正文（窗口截断）',fullOccurs<400,'X 出现 '+fullOccurs+' 次');}
  check('输出 Previous/Current 定位',changed.length>0&&/【上一轮】/.test(changed[0].text)&&/【本　轮】/.test(changed[0].text));
}

/* ── 场景8：同 id 不同 provider 独立（分快照） ── */
{
  const s=newSandbox();
  const cfg={id:'s8',provider:'custom',model:'m8'};
  s.audit(cfg,{model:'m8',messages:[{role:'system',content:'S'},{role:'user',content:'hi'}]},'openai',M('chat'));s.clear();
  s.audit(cfg,{model:'m8',contents:[{role:'user',parts:[{text:'hi'}]}]},'gemini',M('chat'));/* 无 prev.gemini → 记录基线 */
  check('不同 provider 各自建立基线',base(s.logs),s.logs[0]&&s.logs[0].text);
}

/* ══ 场景9：同 consumer 连续两轮 → 正常比较（基线不重建） ══ */
{
  const s=newSandbox();
  const cfg={id:'c9',provider:'custom',model:'m9'};
  const A={model:'m9',messages:[{role:'system',content:'S9'},{role:'user',content:'u1'}]};
  const B={model:'m9',messages:[{role:'system',content:'S9'},{role:'user',content:'u1'},{role:'assistant',content:'a1'},{role:'user',content:'u2'}]};
  s.audit(cfg,A,'openai',M('chat'));s.clear();
  s.audit(cfg,B,'openai',M('chat'));
  check('9. 同 consumer 连续两轮 → 与上一轮比较（非重建基线）',!base(s.logs)&&win(s.logs,/Stable prefix/).length>0,JSON.stringify(s.logs.map(l=>l.text.slice(0,80))));
}

/* ══ 场景10：chat → diary → chat（用户要求的回归） ══
   断言 chat(B).previous === chat(A)：diary 不得覆盖/移动 chat 基线，且 chat B 必须读同一 key。 */
{
  const s=newSandbox();
  const cfg={id:'c10',provider:'custom',model:'m10'};
  const SYS_CHAT='CHAT_SYSTEM_10', SYS_DIARY='你现在是「爱弥斯」，正在写自己的私人日记';
  const chatA={model:'m10',messages:[{role:'system',content:SYS_CHAT},{role:'user',content:'你好'}]};
  const chatB={model:'m10',messages:[{role:'system',content:SYS_CHAT},{role:'user',content:'你好'},{role:'assistant',content:'嗨'},{role:'user',content:'再聊'}]};
  const diaryA={model:'m10',messages:[{role:'system',content:SYS_DIARY},{role:'user',content:'写日记'}]};
  const diaryB={model:'m10',messages:[{role:'system',content:SYS_DIARY},{role:'user',content:'写日记'},{role:'assistant',content:'今天…'},{role:'user',content:'继续'}]};
  const keyChat=s.keyOf('chat',cfg,'openai','m10');
  const keyDiary=s.keyOf('diary',cfg,'openai','m10');

  s.audit(cfg,chatA,'openai',M('chat'));
  const snapA=s.prev[keyChat];
  check('10a. chat A 建立 chat 基线',!!snapA&&snapA.system===SYS_CHAT);

  s.clear();s.audit(cfg,diaryA,'openai',M('diary'));
  check('10b. diary A 建立自己的基线（不与 chat 比）',base(s.logs)&&win(s.logs,/First difference/).length===0,s.logs[0]&&s.logs[0].text);
  check('10c. diary 未覆盖 chat 基线（chat(B).previous === chat(A)）',s.prev[keyChat]===snapA);
  check('10d. 两个请求流 key 不同',keyChat!==keyDiary&&s.prev[keyDiary]&&s.prev[keyDiary].system===SYS_DIARY,keyChat+' / '+keyDiary);

  s.clear();s.audit(cfg,chatB,'openai',M('chat'));
  check('10e. chat B 与 chat A 比（不重建基线）',!base(s.logs)&&win(s.logs,/System: SAME/).length>0,s.logs[0]&&s.logs[0].text);
  check('10f. chat B 不与 diary A 比（否则 System 必为 CHANGED）',win(s.logs,/System: CHANGED/).length===0);
  check('10g. chat 基线推进到 chat B 快照',s.prev[keyChat]!==snapA&&s.prev[keyChat].system===SYS_CHAT);

  /* 单 key 读取证明：把 chat 基线换成哨兵，下一轮必须读到哨兵内容 → 只可能读 chat key */
  s.prev[keyChat]={bs:'POISON_BODY',model:'m10',system:'POISON_SYS',hist:'POISON_HIST',tools:'',struct:''};
  s.clear();s.audit(cfg,chatB,'openai',M('chat'));
  const poison=win(s.logs,/Changed section/);
  check('10h. chat 轮只读 chat 基线（哨兵证明）',poison.length>0&&/POISON_SYS/.test(poison[0].text),poison[0]&&poison[0].text.slice(0,160));

  s.clear();s.audit(cfg,diaryB,'openai',M('diary'));
  check('10i. diary B 与 diary A 比（System: SAME）',!base(s.logs)&&win(s.logs,/System: SAME/).length>0,s.logs[0]&&s.logs[0].text);
}

/* ══ 场景11：同角色 + 同 provider + 同 model，仅 consumer 不同 → 隔离 ══ */
{
  const s=newSandbox();
  const cfg={id:'c11',provider:'custom',model:'m11'};
  const body={model:'m11',messages:[{role:'system',content:'S11'},{role:'user',content:'u'}]};
  s.audit(cfg,body,'openai',M('chat'));s.clear();
  s.audit(cfg,body,'openai',M('moments'));
  check('11. 同角色/provider/model、不同 consumer → 各自建基线',base(s.logs),s.logs[0]&&s.logs[0].text);
  s.clear();s.audit(cfg,body,'openai',M('active.proactive'));
  check('11b. 第三个 consumer 仍不共享',base(s.logs));
}

/* ══ 场景12：不同角色 → 隔离 ══ */
{
  const s=newSandbox();
  const c1={id:'c12a',provider:'custom',model:'m12'},c2={id:'c12b',provider:'custom',model:'m12'};
  const body={model:'m12',messages:[{role:'system',content:'SAME_SYS'},{role:'user',content:'u'}]};
  s.audit(c1,body,'openai',M('chat'));s.clear();
  s.audit(c2,body,'openai',M('chat'));
  check('12. 不同角色（同 consumer/provider/model）→ 隔离',base(s.logs),s.logs[0]&&s.logs[0].text);
}

/* ══ 场景13：不同 provider / model → 隔离 ══ */
{
  const s=newSandbox();
  const body={model:'m13',messages:[{role:'system',content:'S13'},{role:'user',content:'u'}]};
  const cA={id:'c13',provider:'custom',model:'m13'};
  const cB={id:'c13',provider:'anthropic',model:'m13'};
  const cC={id:'c13',provider:'custom',model:'m13-other'};
  s.audit(cA,body,'openai',M('chat'));s.clear();
  s.audit(cB,body,'openai',M('chat'));
  check('13a. 不同 provider → 隔离',base(s.logs));
  s.clear();s.audit(cC,{model:'m13-other',messages:body.messages},'openai',M('chat'));
  check('13b. 不同 model（实际发出的 model 不同）→ 隔离',base(s.logs));
}

/* ══ 场景14：未声明 consumer 自成一档（绝不猜测成 chat） ══ */
{
  const s=newSandbox();
  const cfg={id:'c14',provider:'custom',model:'m14'};
  const body={model:'m14',messages:[{role:'system',content:'S14'},{role:'user',content:'u'}]};
  s.audit(cfg,body,'openai',M('chat'));s.clear();
  s.audit(cfg,body,'openai');/* 无 meta */
  check('14. 未声明 consumer → 不与 chat 共享基线',base(s.logs),s.logs[0]&&s.logs[0].text);
  check('14b. 未声明 consumer 在日志中如实显示 unspecified',/Consumer: \(unspecified\)/.test(s.logs[0].text),s.logs[0]&&s.logs[0].text);
  const keyUnspec=s.keyOf('',cfg,'openai','m14'),keyChat=s.keyOf('chat',cfg,'openai','m14');
  check('14c. key 以 consumer 开头且与 chat 不同',keyUnspec.indexOf('::')===0&&keyUnspec!==keyChat,keyUnspec+' / '+keyChat);
}

/* ══ 场景15：key 形状（consumer::character::provider::model::format），不含易变字段 ══ */
{
  const s=newSandbox();
  const cfg={id:'c15',provider:'custom',model:'m15'};
  const k=s.keyOf('diary',cfg,'openai','m15');
  check('15. key = consumer::character::provider::model::format',k==='diary::c15::custom::m15::openai',k);
  /* gemini 的 model 在 URL 上、body 里没有 → _ibCacheAudit 回落 cfg.model，仍能形成稳定基线 */
  const s2=newSandbox();
  const gcfg={id:'c15',provider:'gemini',model:'m15'};
  s2.audit(gcfg,{contents:[{role:'user',parts:[{text:'u'}]}],system_instruction:{parts:[{text:'S'}]},generationConfig:{maxOutputTokens:32}},'gemini',M('diary'));
  const keys=Object.keys(s2.prev);
  check('15b. gemini 无 body.model 时回落 cfg.model（仍可形成基线）',keys.length===1&&keys[0]==='diary::c15::gemini::m15::gemini',keys.join(','));
}

/* ══ 场景16：审计不修改请求体、不注入任何字段 ══ */
{
  const s=newSandbox();
  const cfg={id:'c16',provider:'custom',model:'m16'};
  const body={model:'m16',messages:[{role:'system',content:'S16'},{role:'user',content:'u'}]};
  const before=JSON.stringify(body);
  s.audit(cfg,body,'openai',M('chat'));
  s.audit(cfg,body,'openai',M('chat'));
  check('16. 请求体逐字节不变',JSON.stringify(body)===before,JSON.stringify(body));
  check('16b. 请求体不含审计身份字段',!/_ibConsumer|consumer/.test(before),before);
  check('16c. 请求体不含 apiKey 之外的任何审计输出',win(s.logs,/apiKey|Bearer /).length===0);
}

/* ══ 场景17：日志必须打印 Consumer/Character/Provider/Model/Format ══ */
{
  const s=newSandbox();
  const cfg={id:'c17',provider:'custom',model:'m17'};
  const body={model:'m17',messages:[{role:'system',content:'S17'},{role:'user',content:'u'}]};
  s.audit(cfg,body,'openai',M('diary'));
  const t=s.logs[0]&&s.logs[0].text||'';
  check('17. 首行含完整请求身份',
    /\[IB Cache Audit\] Consumer: diary \| Character: c17 \| Provider: custom \| Model: m17 \| Format: openai/.test(t),t);
  s.clear();s.audit(cfg,{model:'m17',messages:[{role:'system',content:'S17X'},{role:'user',content:'u'}]},'openai',M('diary'));
  const w=(win(s.logs,/Changed section/)[0]||{}).text||'';
  check('17b. 变更片段行也带 Consumer',/\[IB Cache Audit\] Consumer: diary \| Changed section/.test(w),w.slice(0,120));
}

/* ══ 场景18：兼容别名 _ibOaiCacheDiag 透传 meta ══ */
{
  const s=newSandbox();
  const cfg={id:'c18',provider:'custom',model:'m18'};
  const msgs=[{role:'system',content:'S18'},{role:'user',content:'u'}];
  s.wrap(cfg,msgs,M('role_letters'));
  const t=s.logs[0]&&s.logs[0].text||'';
  check('18. 兼容别名透传 consumer',/Consumer: role_letters/.test(t),t);
}

console.log('\n结果: '+pass+' 通过, '+fail+' 失败');
process.exit(fail?1:0);
