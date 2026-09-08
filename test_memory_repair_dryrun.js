'use strict';

/* Memory provenance 修复流程验证（P2-05）。
   真实 localhost 页面 + 独立 profile + 真实 IndexedDB：
     ① dry-run 只读（plan 前后库内容逐字节相同）；
     ② 只对两类可判定坏记录提出修复，且只收窄、绝不放宽；
     ③ apply 后可见性正确恢复（角色可召回、其他角色不可）；
     ④ 再次 plan/apply 幂等（0 修改）；
     ⑤ 可疑但不可判定的记录只出现在报告里，不被修改。 */

const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');

const harness = fs.readFileSync(path.join(__dirname, 'test_chat_smoke.js'), 'utf8');
const boundary = harness.indexOf('async function main() {');
assert.ok(boundary > 0, 'existing CDP harness boundary changed');
const { chromePath, Cdp, evaluate, waitFor, freePort } = new Function('require', '__dirname',
  harness.slice(0, boundary) + '\nreturn {chromePath,Cdp,evaluate,waitFor,freePort};')(require, __dirname);

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

(async () => {
  const web = require('./internal-beyond-server.js').createWebServer({ root: __dirname, port: 0 });
  const webPort = await listen(web), webBase = 'http://127.0.0.1:' + webPort;
  const debugPort = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-mem-repair-'));
  const chrome = chromePath(); assert.ok(chrome, 'Chrome or Edge required');
  const browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--remote-debugging-port=' + debugPort, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore', windowsHide: true });
  let cdp, failures = 0;
  async function check(name, fn) {
    try { await fn(); console.log('  PASS  ' + name); }
    catch (e) { failures++; console.error('  FAIL  ' + name + '  -> ' + (e && e.message || e)); }
  }
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { ready = (await fetch('http://127.0.0.1:' + debugPort + '/json/version')).ok; } catch (_) {}
      if (ready) break;
      await new Promise(r => setTimeout(r, 100));
    }
    assert.ok(ready, 'CDP readiness');
    const tab = await (await fetch('http://127.0.0.1:' + debugPort + '/json/new?about:blank', { method: 'PUT' })).json();
    cdp = await Cdp.connect(tab.webSocketDebuggerUrl);
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: webBase + '/InternalBeyond.html' });
    assert.ok(await waitFor(cdp, "document.readyState==='complete' && typeof _memRepairPlan==='function' && typeof _memRepairApply==='function' && typeof dbPut==='function'", 20000), 'repair entry mounted');

    /* 清空 memories 后铺入受控样本 */
    const seed = await evaluate(cdp, `(async function(){
      for (const m of await dbGetAll('memories')) await dbDelete('memories', m.id);
      const rows = [
        /* ① 来源受限的 episodic（only 给 role-x） */
        { id:'epi_restricted', kind:'episodic', createdBy:'role-x', visibility:'only', visibleTo:['role-x'], excludeFrom:[],
          title:'受限片段', content:'RESTRICTED_EPI', created:1000, lastConsolidatedAt:null },
        /* ② 被放宽成 public 的 consolidation 产物（provenance 指向 ①） */
        { id:'sem_broad', kind:'semantic', source:'consolidation', createdBy:'role-x', visibility:'public', visibleTo:[], excludeFrom:[],
          title:'被放宽的语义记忆', content:'SEM_BROAD', created:2000, consolidatedFrom:['epi_restricted'] },
        /* ③ provenance 指向已不存在来源的 semantic（只报告不修） */
        { id:'sem_orphan', kind:'semantic', source:'consolidation', createdBy:'role-x', visibility:'public', visibleTo:[], excludeFrom:[],
          title:'无来源语义记忆', content:'SEM_ORPHAN', created:3000, consolidatedFrom:['ghost_source'] },
        /* ④ 旧日记记忆：缺 visibility */
        { id:'diary_old', source:'diary', createdBy:'ai', characterId:'role-x', title:'旧日记记忆', content:'DIARY_OLD', created:4000 },
        /* ⑤ 正常公开记忆：不得被改动 */
        { id:'pub_keep', kind:'episodic', createdBy:'role-x', visibility:'public', visibleTo:[], excludeFrom:[],
          title:'公开记忆', content:'PUBLIC_KEEP', created:5000 },
        /* ⑥ only 但 visibleTo 为空：只报告 */
        { id:'only_empty', kind:'episodic', createdBy:'role-x', visibility:'only', visibleTo:[], excludeFrom:[],
          title:'无人可见', content:'ONLY_EMPTY', created:6000 }
      ];
      for (const r of rows) await dbPut('memories', r);
      return rows.length;
    })()`);
    assert.equal(seed, 6);

    const snapshot = () => evaluate(cdp, `(async function(){var all=await dbGetAll('memories');return all.sort(function(a,b){return a.id<b.id?-1:1})})()`);
    const before = await snapshot();

    let plan = null;
    await check('dry-run：plan 只读，库内容逐字段不变', async () => {
      plan = await evaluate(cdp, `(async function(){return await _memRepairPlan()})()`);
      const after = await snapshot();
      assert.deepEqual(after, before, 'plan 不得写入任何数据');
      assert.equal(plan.scanned, 6);
    });

    await check('dry-run：报告准确列出两类可修复 + 两类只报告', async () => {
      const classes = plan.repairs.map(r => r.class + ':' + r.id).sort();
      assert.deepEqual(classes, ['diary-missing-visibility:diary_old', 'semantic-broadened:sem_broad']);
      assert.deepEqual(plan.report.semanticBroadened.map(r => r.id), ['sem_broad']);
      assert.deepEqual(plan.report.diaryMissingVisibility.map(r => r.id), ['diary_old']);
      assert.deepEqual(plan.report.unresolvedProvenance.map(r => r.id), ['sem_orphan']);
      assert.deepEqual(plan.report.onlyEmptyVisibleTo.map(r => r.id), ['only_empty']);
      /* 计划的目标可见性：semantic 收窄到来源范围；diary 只恢复所属角色 */
      const sem = plan.repairs.find(r => r.id === 'sem_broad');
      assert.deepEqual(sem.to, { visibility: 'only', visibleTo: ['role-x'], excludeFrom: [] });
      const diary = plan.repairs.find(r => r.id === 'diary_old');
      assert.deepEqual(diary.to, { visibility: 'only', visibleTo: ['role-x'], excludeFrom: [] });
    });

    let applied = null;
    await check('apply：只修改计划内两条，且新增字段为可选审计字段', async () => {
      applied = await evaluate(cdp, `(async function(){return await _memRepairApply(${JSON.stringify(plan)})})()`);
      assert.deepEqual({ applied: applied.applied, skipped: applied.skipped, failed: applied.failed }, { applied: 2, skipped: 0, failed: 0 });
      const rows = await snapshot();
      const byId = Object.fromEntries(rows.map(r => [r.id, r]));
      assert.equal(byId.sem_broad.visibility, 'only');
      assert.deepEqual(byId.sem_broad.visibleTo, ['role-x']);
      assert.equal(byId.diary_old.visibility, 'only');
      assert.deepEqual(byId.diary_old.visibleTo, ['role-x']);
      assert.ok(byId.sem_broad.visibilityRepairedAt > 0 && byId.diary_old.visibilityRepairedAt > 0);
      /* 未列入计划的记录逐字段不变 */
      const untouched = ['epi_restricted', 'sem_orphan', 'pub_keep', 'only_empty'];
      for (const id of untouched) {
        const b = before.find(r => r.id === id), a = byId[id];
        assert.deepEqual(a, b, id + ' 不应被修改');
      }
    });

    await check('apply 后：可见性只收窄，未向任何记录放宽', async () => {
      const rank = v => v === 'private' ? 1 : v === 'only' ? 2 : v === 'except' ? 3 : v === 'public' ? 4 : 2;
      const repaired = new Set(plan.repairs.map(r => r.id));
      const rows = await snapshot();
      for (const a of rows) {
        const b = before.find(r => r.id === a.id);
        const rb = rank(b.visibility), ra = rank(a.visibility);
        /* 唯一的允许例外：缺 visibility 的旧日记记忆 → only+[所属角色]。
           该转换把"谁都召回不到"恢复成"只有归属角色能召回"，rank 同级但受众从空变为恰好一个角色；
           除此之外任何同级扩大受众都判失败。 */
        const diaryRestore = a.id === 'diary_old' && !b.visibility && ra === 2
          && a.visibleTo.length === 1 && a.visibleTo[0] === b.characterId;
        if (diaryRestore) continue;
        assert.ok(ra <= rb, a.id + ' 可见性被放宽：' + b.visibility + ' → ' + a.visibility);
        if (ra === rb && ra === 2) {
          for (const who of a.visibleTo) assert.ok((b.visibleTo || []).includes(who), a.id + ' 新增了可见对象 ' + who);
        }
        if (ra === rb && ra === 3) {
          for (const who of (b.excludeFrom || [])) assert.ok(a.excludeFrom.includes(who), a.id + ' 取消了对 ' + who + ' 的排除');
        }
      }
      /* 未列入计划的记录一律不得被改动 */
      for (const a of rows) {
        if (repaired.has(a.id)) continue;
        assert.deepEqual(a, before.find(r => r.id === a.id), a.id + ' 不应被修改');
      }
      assert.equal(rows.find(r => r.id === 'pub_keep').visibility, 'public', '公开记忆保持公开');
    });

    await check('修复后可召回：所属角色可见、其他角色不可见', async () => {
      const got = await evaluate(cdp, `(async function(){var all=await dbGetAll('memories');var byId={};all.forEach(function(m){byId[m.id]=m});`
        + `return{diaryOwn:isMemoryVisibleTo(byId.diary_old,'role-x',false,false),diaryOther:isMemoryVisibleTo(byId.diary_old,'role-y',false,false),`
        + `semOwn:isMemoryVisibleTo(byId.sem_broad,'role-x',false,false),semOther:isMemoryVisibleTo(byId.sem_broad,'role-y',false,false),`
        + `pubOther:isMemoryVisibleTo(byId.pub_keep,'role-y',false,false)}})()`);
      assert.equal(got.diaryOwn, true, '日记记忆必须恢复所属角色召回');
      assert.equal(got.diaryOther, false, '日记记忆不得对其他角色可见');
      assert.equal(got.semOwn, true);
      assert.equal(got.semOther, false, '收窄后的 semantic 不得再对其他角色可见');
      assert.equal(got.pubOther, true, '公开记忆不受影响');
    });

    await check('幂等：再次 plan 无可修复项，再次 apply 0 修改', async () => {
      const again = await evaluate(cdp, `(async function(){var p=await _memRepairPlan();var r=await _memRepairApply(p);return{repairs:p.repairs.length,report:p.report,res:r}})()`);
      assert.equal(again.repairs, 0, '第二次 plan 不应再提出修复');
      assert.deepEqual({ a: again.res.applied, s: again.res.skipped, f: again.res.failed }, { a: 0, s: 0, f: 0 });
      /* 报告仍然如实反映不可判定的记录（幂等不代表报告为空） */
      assert.deepEqual(again.report.unresolvedProvenance.map(r => r.id), ['sem_orphan']);
      assert.deepEqual(again.report.onlyEmptyVisibleTo.map(r => r.id), ['only_empty']);
    });

    await check('写入侧回归：quickCreateMemory 保留 visibleTo/excludeFrom', async () => {
      const got = await evaluate(cdp, `(async function(){var id=await quickCreateMemory({title:'t',content:'c',visibility:'only',visibleTo:['role-z'],excludeFrom:['role-w']});`
        + `var row=await dbGet('memories',id);await dbDelete('memories',id);return{vis:row.visibility,to:row.visibleTo,ex:row.excludeFrom}})()`);
      assert.equal(got.vis, 'only');
      assert.deepEqual(got.to, ['role-z'], 'visibleTo 曾被写入侧丢弃（only 记忆对所有人不可见）');
      assert.deepEqual(got.ex, ['role-w']);
    });

    console.log('\nMemory repair dry-run validation: ' + failures + ' failed');
    process.exitCode = failures ? 1 : 0;
  } finally {
    if (cdp) cdp.close();
    browser.kill();
    web.closeAllConnections();
    await new Promise(r => web.close(r));
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
