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
 *
 * P2-07：入口不再遗漏仓库内的测试脚本。登记条目共 100 条 = 99 个 test_*.js
 * + scripts_check_html.js（HTML 结构检查）；分组：static 37 / service 16 / browser 49。
 * 仓库当前有 99 个 test_*.js；并行会话在途的 test_context_snapshot.js 尚未登记
 * （不属于 P2/P3/P4/P5 改动面，登记与否由该会话决定）。
 * P4：登记 test_setup_wizard.js（static）+ test_setup_wizard_smoke.js（browser）。
 * P5：登记 test_diagnostics.js（static）+ test_diagnostics_smoke.js（browser）。
 * P11-2：登记 test_middle_brain_integrity.js（browser，角色一致性守卫 / OOC Guard）。
 * P11-2A：登记 test_middle_brain_calibration.js（static，校准框架 Layer A · 确定性契约校准）
 *     + test_middle_brain_calibration_live.js（browser，Layer B 默认离线 mock 走真实执行路径；
 *     真实模型校准需手动 --live + IB_CI_CALIBRATION_KEY，不进本强制路径）。
 * P11-FIX：登记 test_cache_audit_isolation.js（browser，Cache Audit baseline 按 runtime consumer 隔离）。
 * P6：登记 test_guide.js（static）+ test_guide_shots.js / test_guide_smoke.js（browser）。
 *     test_guide_shots.js 会真实跑一遍截图管线（约 70s），输出到系统临时目录。
 * P7：登记 test_installer.js + test_installer_mock.js（static，均不安装、不开浏览器）。
 *     真实安装 smoke（test_installer_smoke.js --real-install-smoke）与构建回归
 *     （test_installer_build.js --force）刻意不登记：每个构建只允许一次真实安装，
 *     见 docs/P7-TEST-BUDGET.md。
 * 归类规则：使用 CDP（remote-debugging-port）→ browser；否则 static。
 * 外部依赖测试（需要 Python + 本地 Vision 服务 + test.jpg 的 python test_vision.py）
 * 不进入 --all，单独运行并在报告中如实记录。
 */

const { spawnSync } = require('child_process');
const path = require('path');

const GROUPS = [
  {
    name: 'static',
    note: '语法 / 结构 / 编码 / 纯 Node 契约（无浏览器）',
    tests: [
      ['scripts_check_html.js', 'InternalBeyond.html'],
      ['test_frontend_structure.js'],
      ['test_voice_capture.js'],
      ['test_voice_focus.js'],
      ['test_cache_audit.js'],
      /* P11-2A：角色一致性校准 Layer A（确定性契约校准，零依赖离线） */
      ['test_middle_brain_calibration.js'],
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
      ['test_shopping_execution_e2e.js'],
      ['test_commerce_playwright_smoke.js'],
      /* P2-07 补齐：此前遗漏的纯 Node 测试 */
      ['test_model_core_contract.js'],
      ['test_astra_adapter.js'],
      ['test_llm_transport.js'],
      ['test_llm_proxy.js'],
      ['test_bgai_propagation.js'],
      ['test_call_acoustic_inject.js'],
      ['test_proactive_trace.js'],
      ['test_proactive_phase2.js'],
      ['test_role_letters.js'],
      ['test_video_runtime.js'],
      ['test_voice_pcm_adapter.js'],
      ['test_voice_reconnect.js'],
      ['test_runtime_integration_audit.js'],
      ['test_node_runtime.js'],
      ['test_boot_state.js'],
      ['test_setup_wizard.js'],
      ['test_diagnostics.js'],
      ['test_guide.js'],
      ['test_installer.js'],
      ['test_installer_mock.js']
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
      ['test_voice_capture_live.js'],
      /* P2-07 补齐：此前遗漏的浏览器/CDP 测试 */
      ['test_api_key_mutation_repro.js'],
      ['test_api_key_persist_repro.js'],
      ['test_api_key_ui_status_repro.js'],
      ['test_basement_cdp.js'],
      ['test_bgai_gate.js'],
      ['test_chat_smoke_provider_contract.js'],
      ['test_easteregg.js'],
      ['test_memory_consolidation.js'],
      ['test_memory_lyric_gate.js'],
      ['test_memory_repair_dryrun.js'],
      ['test_middle_brain.js'],
      ['test_middle_brain_admission.js'],
      ['test_middle_brain_advanced.js'],
      ['test_middle_brain_astral.js'],
      ['test_middle_brain_ctx.js'],
      ['test_middle_brain_judge.js'],
      ['test_middle_brain_integrity.js'],
      ['test_middle_brain_seam.js'],
      /* P11-2A：角色一致性校准（Layer B · 离线 mock 真实执行路径；--live 才接真实端点） */
      ['test_middle_brain_calibration_live.js'],
      /* Cache Audit baseline 身份隔离（真实 chat→diary→chat 行为链） */
      ['test_cache_audit_isolation.js'],
      ['test_moments_phase4_smoke.js'],
      ['test_runtime_browser_audit.js'],
      ['test_runtime_optin_smoke.js'],
      ['test_runtime_convergence_proactive.js'],
      ['test_runtime_convergence_moments.js'],
      ['test_runtime_convergence_diary.js'],
      ['test_runtime_convergence_phase4.js'],
      ['test_context_convergence_c1.js'],
      ['test_understanding_admission.js'],
      ['test_understanding_generation.js'],
      ['test_understanding_thread.js'],
      ['test_video_runtime_cdp.js'],
      ['test_boot_smoke.js'],
      ['test_error_ui_smoke.js'],
      ['test_setup_wizard_smoke.js'],
      ['test_diagnostics_smoke.js'],
      ['test_guide_shots.js'],
      ['test_guide_smoke.js']
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
