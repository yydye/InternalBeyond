'use strict';

/* Internal Beyond · 一键全量测试入口（Node 18+，零依赖，跨平台）。
 *
 *   node test-all.js             # 全部（等价 --all）
 *   node test-all.js --quick     # 静态结构 + 本地服务（无需浏览器）
 *   node test-all.js --browser   # 浏览器集成组（需本机 Chrome / Edge）
 *   node test-all.js --all       # 三组全跑
 *
 * 子进程输出透传；任一失败最终返回非零退出码；浏览器测试串行执行
 * （避免 Chrome/CDP 相互干扰）；服务测试自带随机端口与临时数据目录。
 */

const { spawnSync } = require('child_process');
const path = require('path');

const GROUPS = [
  {
    name: 'static',
    note: '语法 / 结构 / 编码（无浏览器）',
    tests: [
      ['scripts_check_html.js', 'InternalBeyond.html'],
      ['test_frontend_structure.js'],
      ['test_voice_capture.js'],
      ['test_voice_focus.js'],
      ['test_cache_audit.js'],
      ['test_harness_boundary.js'],
      ['test_credential_vault.js'],
      ['test_error_catalog.js'],
      ['test_commerce_domain.js'],
      ['test_commerce_mcp_contract.js'],
      ['test_payment_auth.js'],
      ['test_pay_gate.js'],
      ['test_payment_e2e.js'],
      ['test_shopping_agent.js'],
      ['test_shopping_review.js'],
      ['test_payment_canonical.js'],
      ['test_shopping_execution_e2e.js']
    ]
  },
  {
    name: 'service',
    note: 'Bridge / Active 本地服务（随机端口 + 临时数据目录）',
    tests: [
      ['test_bridge.js'],
      ['test_voice_runtime.js'],
      ['test_voice_streaming.js'],
      ['test_mimo_tts.js'],
      ['test_tts_voices.js'],
      ['test_mimo_voiceclone.js'],
      ['test_mimo_voicedesign.js'],
      ['test_active_http.js'],
      ['test_active_plans.js'],
      ['test_proactive_interaction.js'],
      ['test_launcher.js'],
      ['test_moments_companion.js'],
      ['test_moments_http.js'],
      ['test_socialnet_chain_companion_smoke.js'],
      ['test_local_services_runner.js'],
      ['test_restart_backend.js']
    ]
  },
  {
    name: 'browser',
    note: 'Chrome / Edge 集成（串行执行）',
    tests: [
      ['test_game_smoke.js'],
      ['test_chat_smoke.js'],
      ['test_workspace_smoke.js'],
      ['test_memory_smoke.js'],
      ['test_active_diary_smoke.js'],
      ['test_moments_smoke.js'],
      ['test_moments_phase2_smoke.js'],
      ['test_moments_phase3_smoke.js'],
      ['test_moments_user_smoke.js'],
      ['test_socialnet_smoke.js'],
      ['test_socialnet_chain_smoke.js'],
      ['test_activity_smoke.js'],
      ['test_media_adapter_smoke.js'],
      ['test_ui_regression.js'],
      ['test_dual_window.js'],
      ['test_worklet_localhost.js'],
      ['test_voice_capture_live.js']
    ]
  }
];

const mode = process.argv.slice(2).find(a => a.startsWith('--')) || '--all';
const groups = mode === '--all' ? GROUPS : (mode === '--quick' ? GROUPS.slice(0, 2) : GROUPS.slice(2));
if (mode !== '--all' && mode !== '--quick' && mode !== '--browser') {
  console.error('用法：node test-all.js [--quick|--browser|--all]');
  process.exit(2);
}

const startedAt = Date.now();
const results = [];
let failures = 0;

console.log('═'.repeat(72));
console.log('Internal Beyond · 全量测试  mode=' + mode);
console.log('═'.repeat(72));

for (const group of groups) {
  console.log('\n┌─ ' + group.name.toUpperCase() + ' — ' + group.note);
  for (const [script, ...args] of group.tests) {
    const label = [script].concat(args).join(' ');
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [path.join(__dirname, script), ...args], {
      cwd: __dirname,
      stdio: 'inherit',
      shell: false
    });
    const ms = Date.now() - t0;
    const ok = r.status === 0;
    if (!ok) failures++;
    results.push({ group: group.name, label, ms, ok });
    console.log('│ ' + (ok ? 'PASS' : 'FAIL') + '  ' + label + '  (' + (ms / 1000).toFixed(1) + 's)');
  }
}

console.log('\n' + '═'.repeat(72));
console.log('汇总');
for (const group of groups) {
  const rs = results.filter(r => r.group === group.name);
  const total = rs.reduce((s, r) => s + r.ms, 0);
  const fails = rs.filter(r => !r.ok).length;
  console.log('  ' + group.name.padEnd(8) + rs.length + ' 项 · ' + (total / 1000).toFixed(1) + 's · ' +
    (fails === 0 ? '全部通过' : fails + ' 失败'));
}
console.log('总耗时 ' + ((Date.now() - startedAt) / 1000).toFixed(1) + 's · ' +
  (failures === 0 ? '全部通过 ✔' : failures + ' 项失败 ✘'));
process.exit(failures ? 1 : 0);
