/* test_cache_audit.js — [IB Cache Audit] 前缀稳定性/首分歧逻辑单元测试
   直接从生产文件 assets/js/communication.js 抽取自包含的缓存审计块（helpers + _ibCacheAudit）在沙箱内
   eval，测试的是实际交付的代码，而不是另一套重复实现。零依赖，node test_cache_audit.js 运行。 */
'use strict';
const fs=require('fs');
const path=require('path');

const SRC=path.join(__dirname,'assets','js','communication.js');
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
  const sandbox={console:consoleStub,Math,JSON,Array,String,Object,Number,RegExp,parseInt,parseFloat,isNaN};
  const vm=(new Function('console','Math','JSON','Array','String','Object','Number','RegExp','parseInt','parseFloat','isNaN',
    block+'; return {audit:typeof _ibCacheAudit==="function"?_ibCacheAudit:null, wrap: typeof _ibOaiCacheDiag==="function"?_ibOaiCacheDiag:null};'
  ))(consoleStub,Math,JSON,Array,String,Object,Number,RegExp,parseInt,parseFloat,isNaN);
  return {audit:vm.audit,wrap:vm.wrap,logs,clear(){logs.length=0}};
}

let pass=0,fail=0;
function check(name,ok,detail){if(ok){pass++;console.log('  ✓ '+name)}else{fail++;console.log('  ✗ '+name+(detail?(' — '+detail):''))}}
function win(logs,re){return logs.filter(l=>re.test(l.text));}

console.log('IB Cache Audit 单元测试\n');

/* ── 场景1：纯追加 → 前缀稳定 ── */
{
  const s=newSandbox();
  const cfg={id:'s1',model:'m1'};
  const prevBody={model:'m1',messages:[{role:'system',content:'你是助手。'},{role:'user',content:'你好'}]};
  const curBody={model:'m1',messages:[{role:'system',content:'你是助手。'},{role:'user',content:'你好'},{role:'assistant',content:'嗨'},{role:'user',content:'今天天气'}]};
  s.audit(cfg,prevBody,'openai');s.clear();
  s.audit(cfg,curBody,'openai');
  const hit=win(s.logs,/Stable prefix.*纯追加/);
  check('纯追加 → 前缀完全稳定 (OpenAI)',hit.length>0&&/System: SAME \| History: SAME/.test(hit[0].text),hit[0]&&hit[0].text);
}

/* ── 场景2：system 变化 → 前缀提前分歧 ── */
{
  const s=newSandbox();
  const cfg={id:'s2',model:'m2'};
  const prevBody={model:'m2',messages:[{role:'system',content:'A角色设定。'},{role:'user',content:'你好'}]};
  const curBody={model:'m2',messages:[{role:'system',content:'B角色设定。'},{role:'user',content:'你好'}]};
  s.audit(cfg,prevBody,'openai');s.clear();
  s.audit(cfg,curBody,'openai');
  const hit=win(s.logs,/First difference/);
  check('system 变化 → 判定改变',hit.length>0&&/System: CHANGED/.test(hit[0].text)&&/History: SAME/.test(hit[0].text),hit[0]&&hit[0].text);
  check('system 变化 → 首分歧段=SYS',hit.length>0&&/分歧段: SYS/.test(hit[0].text),hit[0]&&hit[0].text);
}

/* ── 场景3：历史中段变化（阶梯窗口回收前）→ History: CHANGED ── */
{
  const s=newSandbox();
  const cfg={id:'s3',model:'m3'};
  const mk=(hist)=>({model:'m3',messages:[{role:'system',content:'S'},{role:'user',content:hist[0]},{role:'assistant',content:'A1'},{role:'user',content:hist[1]},{role:'assistant',content:'A2'},{role:'user',content:'最新'}]});
  s.audit(cfg,mk(['早','中']),'openai');s.clear();
  s.audit(cfg,mk(['早','改']),'openai');
  const hit=win(s.logs,/First difference/);
  check('历史消息变化 → History: CHANGED',hit.length>0&&/History: CHANGED/.test(hit[0].text)&&/System: SAME/.test(hit[0].text)&&/Request structure: SAME/.test(hit[0].text),hit[0]&&hit[0].text);
  check('历史变化 → 首分歧段=HIS',hit.length>0&&/分歧段: HIS/.test(hit[0].text),hit[0]&&hit[0].text);
}

/* ── 场景4：工具集变化 → Tools: CHANGED（OpenAI FC） ── */
{
  const s=newSandbox();
  const cfg={id:'s4',model:'m4'};
  const tools=[{type:'function',function:{name:'f1',parameters:{type:'object'}}}];
  const mk=(t)=>({model:'m4',messages:[{role:'system',content:'S'},{role:'user',content:'hi'}],tools:t});
  s.audit(cfg,mk(tools),'openai');s.clear();
  s.audit(cfg,mk(null),'openai');
  const hit=win(s.logs,/First difference/);
  check('工具集变化 → Tools: CHANGED',hit.length>0&&/Tools: CHANGED/.test(hit[0].text),hit[0]&&hit[0].text);
}

/* ── 场景5：Anthropic 形态判定（system 数组 + 消息级断点） ── */
{
  const s=newSandbox();
  const cfg={id:'s5',model:'m5'};
  const mk=(sys)=>({model:'m5',max_tokens:128,messages:[{role:'user',content:[{type:'text',text:'hi'}]},{role:'assistant',content:[{type:'text',text:'yo'}]},{role:'user',content:[{type:'text',text:'next'}]}],system:[{type:'text',text:sys}]});
  s.audit(cfg,mk('AnS'),'anthropic');s.clear();
  s.audit(cfg,mk('AnS2'),'anthropic');
  const hit=win(s.logs,/First difference/);
  check('Anthropic：system 数组变化 → System: CHANGED',hit.length>0&&/System: CHANGED/.test(hit[0].text),hit[0]&&hit[0].text);
}

/* ── 场景6：Gemini 形态判定（system_instruction） ── */
{
  const s=newSandbox();
  const cfg={id:'s6',model:'m6'};
  const mk=(sys)=>({model:'m6',contents:[{role:'user',parts:[{text:'hi'}]}],system_instruction:{parts:[{text:sys}]},generationConfig:{maxOutputTokens:64}});
  s.audit(cfg,mk('GS'),'gemini');s.clear();
  s.audit(cfg,mk('GS'),'gemini');/* 完全一致 → 纯追加/稳定 */
  s.clear();
  s.audit(cfg,mk('GS2'),'gemini');
  const hit=win(s.logs,/First difference/);
  check('Gemini：system_instruction 变化 → System: CHANGED',hit.length>0&&/System: CHANGED/.test(hit[0].text),hit[0]&&hit[0].text);
}

/* ── 场景7：变更片段为截断+脱敏输出（不泄露完整正文） ── */
{
  const s=newSandbox();
  const cfg={id:'s7',model:'m7'};
  const long='X'.repeat(500);
  const prevBody={model:'m7',messages:[{role:'system',content:'S'},{role:'user',content:long+'.end'}]};
  const curBody={model:'m7',messages:[{role:'system',content:'S'},{role:'user',content:long+'.CHANGED'}]};
  s.audit(cfg,prevBody,'openai');s.clear();
  s.audit(cfg,curBody,'openai');
  const changed=win(s.logs,/Changed section/);
  check('变更片段只显示截断窗口',changed.length>0);
  /* 该片段不应包含整段 500 字原文 */
  if(changed.length){const frag=changed[0].text;const fullOccurs=(frag.match(/XXX/g)||[]).length;check('不打印完整正文（窗口截断）',fullOccurs<400,'X 出现 '+fullOccurs+' 次');}
  /* 同时应给出脱敏/可读片段 */
  check('输出 Previous/Current 定位',changed.length>0&&/【上一轮】/.test(changed[0].text)&&/【本　轮】/.test(changed[0].text));
}

/* ── 场景8：同 id 不同 provider 独立（分快照） ── */
{
  const s=newSandbox();
  const cfg={id:'s8',model:'m8'};
  s.audit(cfg,{model:'m8',messages:[{role:'system',content:'S'},{role:'user',content:'hi'}]},'openai');s.clear();
  s.audit(cfg,{model:'m8',contents:[{role:'user',parts:[{text:'hi'}]}]},'gemini');/* 无 prev.gemini → 记录基线 */
  const hit=win(s.logs,/已记录本对话请求基线/);
  check('不同 provider 各自建立基线',hit.length>0,hit[0]&&hit[0].text);
}

console.log('\n结果: '+pass+' 通过, '+fail+' 失败');
process.exit(fail?1:0);
