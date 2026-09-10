'use strict';

/* Internal Beyond · 一键全量测试入口（Node 18+，零依赖，跨平台）。
 *
 *   node tests/test-all.js             # 全部（等价 --all）
 *   node tests/test-all.js --quick     # 静态结构 + 本地服务（无需浏览器）
 *   node tests/test-all.js --browser   # 浏览器集成组（需本机 Chrome / Edge）
 *   node tests/test-all.js --all       # 三组全跑
 *
 * 本入口与全部测试脚本同住在 tests/，可从任意工作目录运行。
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
 * P14：登记 test_middle_brain_collapse.js（static，API 页 Middle Brain 整块折叠：默认态 /
 *     点击与键盘切换 / 状态保持 / 持久化恢复 / 不重复绑定）。
 * P6：登记 test_guide.js（static）+ test_guide_shots.js / test_guide_smoke.js（browser）。
 * P16：登记 test_api_onboarding.js（static，纯 Node + DOM shim）。
 * P18：登记 test_model_catalog_freshness.js（static，纯 Node + DOM shim；
 *     末尾以子进程跑 test_provider_presentation / test_api_onboarding 作为无回归门）。
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

/* 本文件位于 tests/，因此显式区分两个根：
 *   TEST_ROOT —— 被登记的测试脚本所在目录（tests/）
 *   REPO_ROOT —— 仓库根（== 安装后的应用根），子测试的默认工作目录
 * scripts_check_html.js 归 scripts/，其余登记脚本都在 TEST_ROOT。
 * 子测试 cwd 保持 REPO_ROOT：迁移前 cwd 恰好等于仓库根，这样每个用例的语义
 * 一字不变；单个测试若真的需要别的 cwd，应写在该条目自己的字段里。 */
const TEST_ROOT = __dirname;
const REPO_ROOT = path.resolve(__dirname, '..');

/* 脚本名 → 绝对路径（scripts_check_html.js 例外地住在 scripts/）。 */
const SCRIPT_DIRS = { 'scripts_check_html.js': path.join(REPO_ROOT, 'scripts') };
function scriptPath(name) { return path.join(SCRIPT_DIRS[name] || TEST_ROOT, name); }

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
      /* P14：Middle Brain 整块折叠（静态 DOM stub 驱动真实 config 层，零依赖离线） */
      ['test_middle_brain_collapse.js'],
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
      /* P16：零门槛 API 获取向导（onboarding metadata / 官方-第三方分区 / 预填链路 / 链接安全） */
      ['test_api_onboarding.js'],
      /* P17：Provider 呈现层真源收敛（presentation metadata / 目录驱动下拉 / custom 语义 / 防漂移） */
      ['test_provider_presentation.js'],
      /* P18：模型目录时效（默认模型审计状态 / 新建与切换预填 / 已有配置不迁移 /
         Claude Sonnet 5 采样参数策略 / DeepSeek vision exp 不误判） */
      ['test_model_catalog_freshness.js'],
      /* P19：Anthropic assistant prefill 兼容（Claude 4.6+ 不收 seed → JSON 约束 /
         parser 完整 JSON 优先 / Node port 继承同一 policy / assistant 历史不误删） */
      ['test_anthropic_prefill_policy.js'],
      /* P20：Anthropic wire contract 收敛（system/messages 归一单一真源 /
         Browser（逐字抽取的真实 body builder）× Node（core + node-model-port）parity /
         role invariant / 非 anthropic wire 不变化） */
      ['test_anthropic_wire_contract.js'],
      ['test_installer.js'],
      ['test_installer_mock.js'],
      /* U1：更新清单契约（Stable 通道 schema / 唯一 URL 构造 / 客户端校验与解析），
         纯 Node、不联网、不安装。真实构建期的清单断言在 test_installer_build.js --force。 */
      ['test_update_manifest.js'],
      /* P12：Image Router / Image Scheduler 专项（纯 Node，确定性并发/优先级/失败恢复） */
      ['test_image_router.js'],
      /* P13：图片编辑 / 参考图解析专项（归一化/限额/选源优先级/lineage/多轮 A→B→C/edit 路由） */
      ['test_image_edit.js'],
      /* P15：Image Router 配置层专项（唯一模型目录 / 路由解析 / 能力过滤 / 备用通道 / 错误文案） */
      ['test_image_router_config.js']
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
      ['test_guide_smoke.js'],
      /* P12：Image Router 浏览器最小冒烟（真实链路：Chat/Moments → Router → 现有执行器 → mock provider） */
      ['test_image_router_smoke.js'],
      /* P13：图片编辑浏览器冒烟（<ws_edit_image> → Resolver → Router → multipart /images/edits → A→B→C） */
      ['test_image_edit_smoke.js'],
      /* P15：Image Router 配置层浏览器冒烟（设置 UI → 保存 → 刷新 → 真实请求体用配置的 Key/模型 → 备用通道） */
      ['test_image_router_settings_smoke.js']
    ]
  }
];

const mode = process.argv.slice(2).find(a => a.startsWith('--')) || '--all';
const groups = mode === '--all' ? GROUPS : (mode === '--quick' ? GROUPS.slice(0, 2) : GROUPS.slice(2));
if (mode !== '--all' && mode !== '--quick' && mode !== '--browser') {
  console.error('用法：node tests/test-all.js [--quick|--browser|--all]');
  process.exit(2);
}

/* 每个子测试的硬超时（毫秒）：默认 300s，可用 IB_TEST_TIMEOUT_MS 覆盖。
 * 目的：任何用例“跑完不退出”（Chrome/CDP 残留、未 close 的 server、残留 timer）
 * 都必须表现为 TIMEOUT 失败并继续跑下一项，而不是把整轮全量测试挂死。
 * 实测最长用例 test_guide_shots.js ≈ 70s，300s 有充足余量。 */
const PER_TEST_TIMEOUT_MS = Number(process.env.IB_TEST_TIMEOUT_MS || 300000);

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
    const r = spawnSync(process.execPath, [scriptPath(script), ...args], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      shell: false,
      timeout: PER_TEST_TIMEOUT_MS,
      killSignal: 'SIGKILL'
    });
    const ms = Date.now() - t0;
    const timedOut = !!(r.error && r.error.code === 'ETIMEDOUT');
    const ok = !timedOut && r.status === 0;
    if (!ok) failures++;
    results.push({ group: group.name, label, ms, ok, timedOut });
    const mark = timedOut ? 'TIMEOUT' : (ok ? 'PASS' : 'FAIL');
    console.log('│ ' + mark.padEnd(7) + ' ' + label + '  (' + (ms / 1000).toFixed(1) + 's)');
    if (timedOut) {
      console.log('│         ↳ 超过 ' + (PER_TEST_TIMEOUT_MS / 1000) + 's 未退出，已强杀（该用例很可能未清理浏览器/CDP/服务句柄）');
    }
  }
}

console.log('\n' + '═'.repeat(72));
console.log('汇总');
for (const group of groups) {
  const rs = results.filter(r => r.group === group.name);
  const total = rs.reduce((s, r) => s + r.ms, 0);
  const fails = rs.filter(r => !r.ok).length;
  const hangs = rs.filter(r => r.timedOut).length;
  console.log('  ' + group.name.padEnd(8) + rs.length + ' 项 · ' + (total / 1000).toFixed(1) + 's · ' +
    (fails === 0 ? '全部通过' : fails + ' 失败' + (hangs ? '（其中 ' + hangs + ' 项超时未退出）' : '')));
}
console.log('总耗时 ' + ((Date.now() - startedAt) / 1000).toFixed(1) + 's · ' +
  (failures === 0 ? '全部通过 ✔' : failures + ' 项失败 ✘'));
process.exit(failures ? 1 : 0);
