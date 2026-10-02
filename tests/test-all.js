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
 * P2-07：入口不再遗漏仓库内的测试脚本。
 *
 * ── 计数口径（R2-G2；刻意不写死会立刻腐烂的"测试总数"）────────────────────
 * 权威口径由 registry 在启动时**机械计算并打印**：
 *     registry: <entries> entries · <unique> unique scripts · static <n> / p22-ui <n> /
 *               service <n> / browser <n>
 * 四个量互不相等，必须分开命名，禁止混成一个"测试总数"：
 *   · registry entries            —— GROUPS 的登记条目（同一脚本可因不同 flag 登记多次）
 *   · unique executable scripts   —— 去重后的可执行脚本数
 *   · repo-discovered test files  —— 仓库中实际存在的 test_*.js（含**故意未登记**的）
 *   · intentionally unregistered  —— 见本文件 "Intentionally unregistered" 台账
 * `validateRegistry()` 在跑任何测试**之前**拒绝悬空/未登记的重复登记，
 * 因此本注释不需要、也不允许再手写这些数字。
 * M1-A：新增 static 四条 —— test_lan_bridge_auth_contract.js（R19/§3.14 LAN 鉴权一致性）、
 *     test_chat_core_contract.js（Chat Message Contract）、
 *     test_chat_authority.js（权威/镜像/回退三态策略）、
 *     test_chat_migration.js（IndexedDB → Home Node 迁移端到端幂等）；
 *     service 两条 —— test_home_node_http.js（真实 HTTP 集成）、
 *     test_home_node_service.js（服务进程与 runner 注册契约）；
 *     browser 一条 —— test_m1a_chat_authority_smoke.js（真实 Home Node 进程 +
 *     真实 sendChatMessage，证明桌面单聊在切换权威之后仍然工作，且离线时 fail closed）。
 * test_context_snapshot.js 仍未登记：它由另一条并行工作线拥有（不属于本入口的登记
 * 决定），R2-G2 只如实保留该 ownership，不代其裁决（详见文件末尾台账）。
 * P4：登记 test_setup_wizard.js（static）+ test_setup_wizard_smoke.js（browser）。
 * P5：登记 test_diagnostics.js（static）+ test_diagnostics_smoke.js（browser）。
 * P11-2：登记 test_middle_brain_integrity.js（browser，角色一致性守卫 / OOC Guard）。
 * P11-2A：登记 test_middle_brain_calibration.js（static，校准框架 Layer A · 确定性契约校准）
 *     + test_middle_brain_calibration_live.js（browser，Layer B 默认离线 mock 走真实执行路径；
 *     真实模型校准需手动 --live + IB_CI_CALIBRATION_KEY，不进本强制路径）。
 * Astra Readiness Phase 1（观测阶段，零调参）：登记
 *     test_astra_readiness_observe.js（static，真实生产装配上的只读观测：
 *       dialogueChars 分布与 600/3500 分档、multipleThreads 触发分布、MB_GATE_STATE
 *       归属与宿主分叉的确定性反例、本阶段零生产改动的 git diff 断言）
 *     + test_middle_brain_calibration_live.js --corpus=readiness --rewrite --verify
 *       （browser，同一 harness 的有界离线观测跑：A–U 语料 + 三段执行 + §12 安全包络）。
 *     真实模型观测仍不在强制路径里，而且**当前没有合法凭据**（见
 *     docs/ASTRA_READINESS_PHASE1.md 的 §2）。
 * Astra Readiness Phase 1B（live judge pilot 的**前置修正**）：Phase 1 声称的
 *     "显式 --live 而凭据不齐时 exit 3 中止"在运行期**从来没有成立过** ——
 *     LIVE_MODE 声明在首次引用之后，LIVE 为真时不短路，必抛 TDZ ReferenceError，
 *     凭据闸门永远不可达（离线跑因 LIVE===false 短路，所以任何离线回归都测不到）。
 *     已修 harness（仅调整声明顺序，语义零变化），并登记
 *     test_calibration_live_abort.js（static，静态顺序不变量 + 运行期真跑 --live
 *     且清空凭据，断言 exit 3 / stdout 一字不出 / 无 JS 栈 / 零浏览器）。
 *     live pilot 本体未执行：本机无合法凭据。
 * Astra Readiness Phase 1B（第二个前置修正）：**观测口径的期限阶梯**。共享 CDP 客户端
 *     把 Runtime.evaluate 的期限硬编码成 15000 ms，而校准要用它等在页面里跑完生产守卫
 *     （judge/astra/integrity 各 20000 ms）——客户端先于生产放弃，把生产裁决掩盖成
 *     `CDP timeout: Runtime.evaluate`。已让该期限可配（IB_CDP_TIMEOUT_MS，默认仍是
 *     15000，其他 harness 行为逐字不变），校准侧默认 30000 并在 <= 20000 时大声中止；
 *     登记 test_cdp_deadline_band.js（static，解析口径 + 结构不变量 + 同一个 17 s
 *     合成延迟在两个期限下结果相反的离线行为证据）。
 * P11-FIX：登记 test_cache_audit_isolation.js（browser，Cache Audit baseline 按 runtime consumer 隔离）。
 * M1-C.2d Wave 1：登记 test_memory_contract_closure.js（static，Memory Contract Closure ——
 *     隐藏记忆不得经 Understanding / Thread 派生回流；证据收紧或不可查时制品 fail closed；
 *     编辑保留 consolidation provenance；检索 visibility-before-ranking 且选择/激活分离）；
 *     并补登记 test_home_node_execution.js（service）—— 该执行缝测试此前存在但
 *     从未进套件，等于 Home Node 执行链没有回归门。
 * P21：登记 test_reasoning_capability.js（static，canonical reasoningEffort 能力表 / 边界翻译 /
 *     auto 不改变请求 / 未取证 provider 不污染）
 *     + test_middle_brain_reasoning_effort.js（browser，真实 wire body：MB disabled 零注入 /
 *     chat×diary parity / DeepSeek 原生 auto 不受影响 / Speed 与 Effort 分离）。
 * M1-C.2i：登记 test_middle_brain_convergence.js（static，执行收敛：同一份发布策略 →
 *     两端同一语义决策；Home Node 复用既有执行缝；注入契约；伪造请求免疫；凭据不可达；
 *     失败语义可区分）
 *     + test_middle_brain_convergence_counterproof.js（static，对照证明：五处单向弱化
 *     各自让收敛测试变红，且红的是预期断言 —— 证明断言真的有鉴别力）。
 *     两条都只复制相关文件到临时目录、不触网、不改工作区。
 *     + test_home_node_middle_brain_assembly.js（service，生产装配 buildHomeNode() + 真实
 *     回环 provider：证明执行缝在**生产装配**里真的接上了，而不是只有测试自己接线时成立）。
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
 * U1/U2/U3：登记 test_update_manifest.js / test_update_check.js / test_update_install.js /
 *     test_pe_version.js（static，纯 Node、不联网、不构建也不安装任何安装包）。
 * U4：登记 test_update_card.js（static）+ test_update_card_smoke.js（browser）。
 *     U4 不重新验证 U3 的安装逻辑，也不跑真实安装器。
 * 归类规则：使用 CDP（remote-debugging-port）→ browser；否则 static。
 * 外部依赖测试（需要 Python + 本地 Vision 服务 + test.jpg 的 python test_vision.py）
 * 不进入 --all，单独运行并在报告中如实记录。
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
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
const SCRIPT_DIRS = {
  'scripts_check_html.js': path.join(REPO_ROOT, 'scripts'),
  /* Release Tooling R1：Release Builder 的套件与它自己的 fixture 住在一起
     （tools/release-builder/tests/），所以它的三个入口在这里登记目录。 */
  'test_release_builder_plan.js': path.join(REPO_ROOT, 'tools', 'release-builder', 'tests'),
  'test_release_builder_astages.js': path.join(REPO_ROOT, 'tools', 'release-builder', 'tests'),
  'test_release_builder_server.js': path.join(REPO_ROOT, 'tools', 'release-builder', 'tests'),
  'test_release_builder_exe.js': path.join(REPO_ROOT, 'tools', 'release-builder', 'tests'),
  /* R2-G2 · Registry 修复：这 6 条的登记名曾带 `packaging_` 中缀，而
     tools/packaging-control-plane/tests/ 下的真实文件从来**不带**该中缀
     （test_contract.js / test_environment_inspector.js / test_build_planner.js /
      test_artifact_validator.js / test_manifest_writer.js / test_executor.js）。
     后果是每轮 aggregate 都有 6 条 "Cannot find module" 的稳定失败。
     现在按**真实文件名**登记；文件本身一字未动。 */
  'test_contract.js': path.join(REPO_ROOT, 'tools', 'packaging-control-plane', 'tests'),
  'test_environment_inspector.js': path.join(REPO_ROOT, 'tools', 'packaging-control-plane', 'tests'),
  'test_build_planner.js': path.join(REPO_ROOT, 'tools', 'packaging-control-plane', 'tests'),
  'test_artifact_validator.js': path.join(REPO_ROOT, 'tools', 'packaging-control-plane', 'tests'),
  'test_manifest_writer.js': path.join(REPO_ROOT, 'tools', 'packaging-control-plane', 'tests'),
  'test_executor.js': path.join(REPO_ROOT, 'tools', 'packaging-control-plane', 'tests')
};
function scriptPath(name) { return path.join(SCRIPT_DIRS[name] || TEST_ROOT, name); }

const GROUPS = [
  {
    name: 'static',
    note: '语法 / 结构 / 编码 / 纯 Node 契约（无浏览器）',
    tests: [
      ['scripts_check_html.js', 'InternalBeyond.html'],
      ['test_frontend_structure.js'],
      /* P36 · grouped sidebar, original page ids/hash routing and secret/Tauri route compatibility. */
      ['test_navigation_shell.js'],
      /* P37-FIX · Welcome/Home ownership, Home-only lazy aggregation, bounded projections, and routing boundaries. */
      ['test_home_workspace.js'],
      /* P31 · Middle Brain Direct Channel：隐藏 query route、双 prompt contract、
         有界只读 resolver、独立 transcript namespace 与 canonical Astra seam。 */
      ['test_middle_brain_direct.js'],
      /* P32-W.3 · Browser URL/hash 与 Tauri console 共用的 allowlist resolver，
         只验证归一化、既有 handler identity 与零副作用解析。 */
      ['test_secret_routes.js'],
      ['test_secret_routes_acceptance_contract.js'],
      ['test_voice_capture.js'],
      ['test_voice_focus.js'],
      ['test_cache_audit.js'],
      /* M1-B：设备身份 / 配对 / 会话单次使用 / token 哈希存储（领域层，零依赖离线）。
         不经过 HTTP —— HTTP 语义由 service 组的 test_mobile_gateway_http.js 覆盖。 */
      ['test_mobile_device_registry.js'],
      /* P11-2A：角色一致性校准 Layer A（确定性契约校准，零依赖离线） */
      ['test_middle_brain_calibration.js'],
      /* Astra Readiness Phase 1：只读观测（不调参、不启用）。
         跑在**真实生产装配**上（Home Node 的 canonical loader：
         config/policy/astra/judge/integrity + facade 就是生产那一份）：
           ① 语料 dialogueChars 分布 + 600/3500 分档（只测量，不改阈值）
           ② multipleThreads 的触发分布、触发原因、是否"理解块两行就足以激活"
           ③ MB_GATE_STATE 的归属 / 生命周期 / 持久化 / 宿主分叉，
              并给出**确定性反例**（同一份证据 + 不同宿主本地状态 → 不同判定）
           ④ 本阶段零生产改动（git diff 逐条断言）
         纯 Node、零网络、零浏览器。 */
      ['test_astra_readiness_observe.js'],
      /* Astra Readiness Phase 1B：`--live` 凭据预检（clean abort）回归。
         它存在的理由是 Phase 1B 实测到的真实 harness 缺陷：LIVE_MODE 曾被声明在
         首次引用**之后**，`LIVE` 为真时不短路 → 传 --live 必抛 TDZ ReferenceError，
         于是 exit 3 凭据闸门**永远不可达**（"绝不静默降级成 mock"这条性质此前
         从未在运行期成立过，离线跑因 LIVE===false 短路而永远测不到它）。
         本测试 = 静态顺序不变量 + 运行期真跑一次 --live（凭据被显式清空）。
         子进程在模块求值期即中止：零网络、零浏览器、零真实 API 调用，
         且在"合法持有凭据"的机器上同样确定性走中止分支。 */
      ['test_calibration_live_abort.js'],
      /* P23 Phase 2A：Message Sequence Contract —— 一次模型回合交付 N 条**独立**
         canonical chatMessage 的数据契约：sequence → messages 的纯构造、回合身份
         （metadata.turnId / sequenceIndex / sequenceTotal）、确定性顺序
         （回合内按 sequenceIndex、回合整体落在最早一条的位置 —— 修掉"工具续轮先落库、
         主回复后落库 ⇒ reload 后顺序颠倒"这一真实缺陷）、真实 Home Node store 的
         持久化/重放幂等/重启、真实撤回函数体的 unit 级语义、legacy 兼容、
         export/import、search、context reconstruction、provider wire 归一
         （连续 assistant 的 gemini 兼容性）、secret 探针、malformed/空 unit、
         stale voice、Mobile DTO、无重复注入。纯 Node：真 SQLite 临时库 +
         真共享核心，零浏览器、零网络。 */
      ['test_message_sequence_contract.js'],
      /* P23 Phase 2B：Delivery Runtime —— 一个 sequence **如何被交付**：
         队列状态机（queued/delivering/completed/cancelled/failed）、确定性 timing
         （delayBefore / typingDuration，两端夹紧，绝无 Math.random 与真实 sleep）、
         typing ON/OFF 与"typing OFF 消息才出现"、cancel/user interrupt 的
         部分交付保留、会话与 thread 隔离（按 canonical conversationId，不写死 friendId）、
         voice 只在它自己的交付时刻出现、交付失败 fail closed、reload 后队列 ephemeral、
         以及硬验收线"未交付 unit 不在 DB / context / memory / search 里"。
         用**假时钟 + 真实 adapter 函数体沙箱**驱动：零浏览器、零网络、零真实等待。 */
      ['test_delivery_runtime.js'],
      /* P23 Phase 2C：Delivery Planner —— "模型一次生成的内容 → delivery sequence" 的
         唯一规则型 planner（纯逻辑层）：结构保护（代码块/链接/图片/强调/列表/引用/
         sticker·emoji/URL/JSON 一律不被内部切碎）、句读与转折分句切分、
         min/max unit 长度策略（避免"你""好"各一条，也避免 5000 字一个气泡）、
         persona/style hint（唯一 extension point，只移动上界、绝不改写内容）、
         legacy 单条 fast path、功能标签整条不拆、无随机/无时钟/无 DOM/无网络、
         与 Phase 2A 契约和 Phase 2B runtime 的兼容、voice/image 占位符保持完整。
         纯函数测试：零浏览器、零网络、零真实 sleep。 */
      ['test_delivery_planner.js'],
      /* P23 Phase 2D：Multimodal Delivery Policy —— "这一段是 text 还是 voice" 的唯一决策点
         （image 本阶段 DEFERRED，并有正式 contract 记录）：capability ≠ preference ≠ intent、
         默认恒为 text、软偏好不升级结构、显式意图可升级（有预算护栏）、voice 不可用时
         确定性降级为同内容 text（绝不换 provider / 绝不静默）、秘密消毒（capability 只暴露
         可用性）、以及 delivery-time 物化的成本语义（cancel/interrupt ⇒ 零 TTS 请求）。
         用**假时钟 + 真实 adapter 函数体沙箱 + 注入的 fake TTS**驱动：零浏览器、零网络、
         零真实 sleep、零真实 provider。 */
      ['test_multimodal_delivery_policy.js'],
      /* Astra Readiness Phase 1B：**校准的 CDP RPC 期限必须长于生产模型期限**。
         实测缺陷：共享 CDP 客户端（test_chat_smoke.js 的 Cdp.send）把
         Runtime.evaluate 的期限硬编码成 15000 ms，而校准 harness 正是用它等在页面里
         跑完**生产**角色一致性守卫（judge/astra/integrity 三层各 20000 ms）。
         客户端先放弃 → `CDP timeout: Runtime.evaluate`，与"模型没回来"无法区分，
         观测口径掩盖了生产裁决。对照实验：8 s → 走完；>15 s 且 <20 s → 假 CDP timeout；
         >20 s → 生产自己的 judgeError:'timeout'。
         本测试 = 解析口径（非法值安全回落 15000）+ 结构不变量（校准默认 30000 > 生产
         20000，且生产字面量从生产源码里读）+ 行为证据（**同一个** 17 s 合成延迟，
         默认客户端超时、校准客户端成功）。全程离线、零浏览器、零真实 API 调用。 */
      ['test_cdp_deadline_band.js'],
      /* P14：Middle Brain 整块折叠（静态 DOM stub 驱动真实 config 层，零依赖离线） */
      ['test_middle_brain_collapse.js'],
      /* P11-3：Middle Brain 语义务闭合（UI/runtime 状态机 + local 注入契约纯函数表，
         静态 DOM/IndexedDB 桩驱动真实 config 层，零依赖离线） */
      ['test_middle_brain_semantics.js'],
      /* P21：统一思考深度（canonical reasoningEffort）能力表与边界翻译 ——
         auto 不写字段 / 逐档映射 / 未取证 provider·model 不污染 body / 降级与 fallback /
         能力真源唯一性结构守卫 / Speed 与 Effort 分离 / usage 只读提取 /
         DeepSeek 校准（P21.1：模型级登记 · medium→high · 无 provider 宽泛开启）。
         纯 Node，零依赖、不联网、不开浏览器。 */
      ['test_reasoning_capability.js'],
      /* M1-C.2i：Middle Brain 执行收敛 —— 同一份已发布的执行策略在 Desktop 与
         Home Node 得到同一个 canonical 语义决策；Home Node 进入的是**既有**执行缝
         （require assets/js 那五层 + facade，不是等价实现）；注入契约、伪造请求免疫、
         凭据结构性不可达、失败语义可区分、每轮只进一次。纯 Node，零依赖、不联网。 */
      ['test_middle_brain_convergence.js'],
      /* M1-C.2i 对照证明：把工作区里相关文件复制到临时目录并**单向弱化**五处
         （绕开执行缝 / 换思考深度 / 丢掉 integrity 结果 / 让 payload 覆盖策略 /
         把凭据投影出去），每一处都必须在副本里让收敛测试变红，且红的是预期的那些断言。
         不触网、不改工作区、结束时清理。 */
      ['test_middle_brain_convergence_counterproof.js'],
      /* M1-A（R19/§3.14）：LAN 模式桌面端鉴权一致性契约 ——
         window.ibBridgeToken 发布 / 无裸 fetch(ibBridgeBase()…) /
         无 new Audio(ibBridgeBase()…)（媒体元素无法带请求头 → 必须 blob 取回）。
         纯静态文本分析，不联网、不开服务、不开浏览器。 */
      ['test_lan_bridge_auth_contract.js'],
      /* M1-A（Phase 1/3）：Chat Message Contract —— 生产写入形状全覆盖 /
         conversation identity 派生与逆函数 / message id 形状保真 /
         幂等 requestId→messageId 确定性 / payload 往返不丢未知字段。纯 Node。 */
      ['test_chat_core_contract.js'],
      /* P23 Phase 1：Voice API Source（canonical source 引用 / 旧 voice 配置不回归 /
         endpoint 由 Bridge 唯一解析 / credential 绝不进入角色记录与 wire payload）。
         P23 Phase 1：Native Voice Message（assistant 一级语音消息的 create / persist /
         hydrate / render decision / play / duration / transcript / provenance / 失败边界）。 */
      ['test_voice_source.js'],
      ['test_native_voice_message.js'],
      /* P23 Phase 1.1（Closure Fix）：Voice 播放取源路径（引用型必须走 ibBridgeLoadAudio，
         绝不允许裸 new Audio(相对 /tts 路径)）+ Voice message 生命周期（撤回/续写/编辑/
         重新生成后 voice 与 content 只能有一个真相）。 */
      ['test_voice_playback_path.js'],
      ['test_voice_message_lifecycle.js'],
      /* M1-A（Phase 7/16）：浏览器权威层三态策略 —— 写先到 Home Node 再落镜像 /
         Home Node 离线时写 fail closed 且读走镜像并标 degraded /
         镜像写失败仍以 Home Node 为权威并如实报告 / 明确拒绝不当作离线 /
         mirror·off 模式退回本地且不宣称权威。mock remote + mock local，零网络。 */
      ['test_chat_authority.js'],
      /* M1-A（Phase 6）：IndexedDB → Home Node 迁移端到端 —— 空库 / 已有消息 /
         重复迁移 / 中断续跑 / 混合 thread / images·files·voice payload /
         migrated marker 版本。用真实 chat-store + 真实 mock HTTP，零浏览器。 */
      ['test_chat_migration.js'],
      /* M1-C.2d Wave 1：Memory Contract Closure —— 隐藏记忆不得经任何派生制品
         （Understanding / Thread）回流进该角色的模型输入；证据可见性收紧 / 不可查
         时制品不得静默保持有效；编辑 consolidated 记忆保留 provenance；
         检索保持 visibility-before-ranking，且选择（纯）与激活强化（副作用）分离。
         抽取真实生产源码片段在 vm 中执行，零浏览器、零网络。 */
      ['test_memory_contract_closure.js'],
      /* P21-R2-A：Memory Recall Contract —— 冻结 recall orchestration 的语义边界：
         channel 词表（legacy/surface/recall/glossary/coldStart/reminisce）、reason 词表
         （保留既有三值 + 新增 early-exit/gate-rejected，只增不改）、
         "0 memory 是合法成功结果"、relevanceScore 可取 0、
         relevanceScore 与 memoryValue 分离（LegacyMemoryValue 仅作兼容定义，
         不永久冻结四因子公式）、visibility 必须先于 relevance/ranking/trace detail、
         唯一 ACL、cooldown 先 session-local（RecallSessionState，不扩 TELEMETRY_FIELDS）、
         Trace 禁止正文/凭据、Auto Memory 登记为并行管线、
         D-7 登记为 Known Authority Gap（不修）、
         以及 production memory runtime 文件逐字节未变（SHA-256 基线）。
         断言分 [CONTRACT]（契约文本）与 [CURRENT]（当前代码事实，记录现状、
         在现状变化时变红）。纯 Node、零浏览器、零网络。 */
      ['test_memory_recall_contract.js'],
      /* P21-R2-B：Turn Signal / Early Exit + Deterministic Query Construction。
         两个新模块（assets/js/memory-recall/turn-signal.js 与 recall-query.js）是
         **implemented but unwired** 的纯函数：零 IO / 零时钟 / 零随机 / 零 LLM，
         lexicalTerms 依赖注入复用 memory-retrieval-core.js 的 extractKeywords
         （不复制第二套 n-gram 实现）。
         early-exit 部分钉住 R2-B 冻结的优先级（host-forced → coldStart →
         explicit recall → semantic payload → early exit）以及"绝不按长度判断"、
         "只做 normalized exact match（不 substring）"两条纪律；
         query 部分钉住归一化 / boilerplate 去噪（保护引号段）/ entities /
         temporal hints / aliases / 有界输入 / 确定性；wiring guard 证明生产面
         零引用，并把 R2-A 的 141 条契约断言作为子进程回归跑一遍。
         纯 Node、零浏览器、零网络。 */
      ['test_memory_recall_early_exit.js'],
      ['test_memory_recall_query.js'],
      ['test_memory_recall_wiring_guard.js'],
      /* P21-R2-C：Orchestrator Skeleton + Hard Gate + Recall Trace + Legacy Parity。
         C1（接线，行为等价）：桌面 selectMemoryContext 与 Home Node retrieve
         改为经 memory-recall-orchestrator；两个 Host 都**不传 turn**，因此
         内部走 legacy path 直接委托同一份 memory-retrieval-core。
         C2（新语义，Host 暂不启用）：early exit / deterministic query /
         visibility pre-filter / relevanceScore / Hard Gate(relevanceScore>0) /
         RecallTrace（脱敏、零日志出口）。
         legacy_parity 是本轮的**硬门**：29 组 fixture 下
         deepStrictEqual(orchestrator.result, core.buildMemoryContext)，
         逐字节比对 text / selected / count / chars / reason。
         纯 Node、零浏览器、零网络。 */
      ['test_memory_recall_scoring.js'],
      ['test_memory_recall_trace.js'],
      ['test_memory_recall_orchestrator.js'],
      ['test_memory_recall_legacy_parity.js'],
      ['test_memory_recall_two_host_parity.js'],
      /* P21-R2-D：Surface + Recall 语义切换（**用户可见行为第一次改变**）。
         Host 正式传 turn.message；channel-policy 实现 surface / recall
         （glossary / coldStart / reminisce 显式 future，fail closed，不静默
         映射成 surface）；seat-planner 施加通道**产品预算**上限
         （surface 3 / recall 5，不是相关性阈值）。
         semantic_delta 是本阶段的**硬门**：每个 fixture 先声明
         EXPECTED SAME | CHANGED，再测实际 delta —— 未批准的变化即 regression。
         legacy 兼容层不删除（不传 turn 仍逐字节等价，29 fixtures 仍绿）。 */
      ['test_memory_recall_channels.js'],
      ['test_memory_recall_seats.js'],
      ['test_memory_recall_semantic_delta.js'],
      /* P21-R2-E1a：catalog contract + conversation signal plumbing。
         两者都是 **latent**：glossary / coldStart 仍未在 production 启用，
         用户可见召回语义与 R2-D 完全相同（semantic delta 仍 10 CHANGED / 14 SAME）。 */
      ['test_memory_recall_glossary_catalog.js'],
      ['test_memory_recall_coldstart_signal.js'],
      /* P21-R2-E1b：glossary / coldStart 正式启用（retrieval cutover）。
         coldStart 的 activationPolicy = 'none' —— 注入但不强化。 */
      ['test_memory_recall_glossary.js'],
      ['test_memory_recall_coldstart.js'],
      /* P21-R2-F1a：canonical selector 缺陷闭合 + pre-F 静态基线。
         baseline = 只读的 frozen 数据（绝不 regenerate）；delta = 旧/新对照矩阵。 */
      ['test_memory_recall_r2f_baseline.js'],
      ['test_memory_recall_r2f_delta.js'],
      ['test_memory_recall_session_state.js'],
      ['test_memory_recall_cooldown.js'],
      ['test_memory_recall_r2f_cooldown_baseline.js'],
      ['test_memory_recall_r2f_cooldown_delta.js'],
      ['test_memory_recall_cooldown_hosts.js'],
      /* M1-C.2m：canonical Understanding —— 存储/修订链/CAS/单活不变量/更正契约
         （纯 Node + 真 SQLite + 临时数据目录，零网络、零浏览器）。 */
      ['test_understanding_contract_closure.js'],
      /* M1-C.2m：理解域的执行收敛 —— 同一份 canonical 状态在 Desktop 与 Home Node
         给出同一组理解证据（理解维度的 Same Evidence），以及零解释差异清单。
         纯 Node：真实共享核心 + 真实 store + 生产 gateway 装配。 */
      ['test_understanding_authority.js'],
      /* M1-C.2o：对话证据（哪些话算"当前对话"）的 Same Evidence。
         P0 审计：这条语义此前两个宿主各写一份而且**两份都不一样** ——
         桌面根本不传 dialogue（组织层恒得空数组、注入块里没有【当前对话】段），
         Home Node 传自己那份 400 字 / 8 条投影。本阶段收敛成唯一实现
         （assets/js/dialogue-core.js，浏览器与 Node 双载同一份），两端对
         **同一段 canonical 对话**投影出同一段证据。
         覆盖 T1–T15：多轮 / 当前行已 canonical / 同步滞后 / 重试重放 /
         连发与重新生成 / 连排助理行 / 删除行 / 空历史 / 检索失败 /
         话题隔离 / 长窗口边界 / 两端字节 parity / 认知边界相等 /
         provider 序列化不重新引入差异 / Android 不得成为第二个对话权威；
         每条 parity 都配反证（合法改动对话证据必须改变结果）。
         纯 Node + 真 SQLite + 真执行器 + 真实共享核心。 */
      ['test_dialogue_authority.js'],
      /* M1-C.2p：Character Integrity 的对话证据收敛。
         P0 审计：M1-C.2o 之后 cognition dialogue 只剩一个定义，但
         middle-brain-integrity.js 仍自带一份 `_ciHistory`（自己的 8 条窗口 /
         400 字单条上限 / 2400 字预算 / 角色映射 / 排序），而且桌面那个调用点
         交给它的是 **provider 请求数组**（system 行 + 挂在末条 user 消息上的
         系统注入块 + transport 变形）—— 也就是"她这一轮被判定得符不符合角色"
         所依据的对话，与认知层看到的那段**不是同一段**。
         本阶段把它收敛到共享核心（IBDialogueCore.assemble）：guard 只消费
         canonical 投影，自己的预算 / 渲染 / 维度可用性全部发生在投影之后。
         覆盖：结构唯一性（全仓扫描：带引号的行标签与 `_ciHistory` 只允许出现在
         共享核心与 guard 渲染器里）、T1–T20 对抗用例 × 两个宿主形状、
         双宿主逐字 parity、当前回合归属 / 去重 / 重放、消费预算边界、
         before/after 行为保持矩阵（收紧只允许出现在"旧投影把当前回合当成前序
         对话"这一处，且只可能更保守）、以及**对照证明**（把旧投影装回临时副本，
         同一批收敛断言必须 RED：实测 102 条变红）。
         纯 Node + 真执行器装配，零网络、零浏览器。 */
      ['test_ci_dialogue_authority.js'],
      /* M1-C.2n：Moments ACL 契约（M-ACL-1..10）—— 冻结后的可见性语义、
        fail-closed、隐藏行不挤占 top-k/分页/预算、子制品不得更宽，
        以及**结构性**断言的"生产代码里不存在第二份可见性判定"。
        纯 Node，零浏览器（同一份核心在两个宿主里跑，见 M-ACL-9 的双载断言）。 */
      ['test_moments_acl_contract.js'],
      /* M1-C.2n：canonical Moments —— store 写协议（CAS/幂等重放/墓碑/迁移不覆盖/
        revision 命名空间与其它权威隔离）、可见分页、两端逐字一致（parity）、
        竞态 R1–R7、反证 C1–C6、以及 Android/设备面的安全边界。
        纯 Node + 真 SQLite + 临时数据目录。 */
      ['test_moments_authority.js'],
      /* M1-C.2d Wave 2：canonical memories authority —— 与 chat 同一套三态语义
         （写先到 Home Node 才落镜像 / 离线 fail closed / 明确拒绝 ≠ 离线 /
         镜像写失败仍以 Node 为权威）；记忆可编辑 → 内容变化必须真更新；
         激活遥测不参与内容等价判定；激活强化走独立通道不推进 revision；
         权威状态显式可读（authority / authorityEffective / degraded）。
         mock remote + mock local，零网络。 */
      ['test_memory_authority.js'],
      /* M1-C.2d Wave 2：IndexedDB memories → Home Node 迁移端到端 ——
         空库 / 已有记忆（provenance·consolidation·未知字段往返）/
         重复迁移幂等 / 遥测漂移不破坏幂等 / 中断不写水位、
         受控截断写水位 / 续跑结果与不间断迁移逐条相等 /
         **可见性逐字保留**（缺失 visibility 保持缺失）/ 迁移前后召回一致。
         真实 memory-store + 真实 mock HTTP，零浏览器。 */
      ['test_memory_migration.js'],
      /* M1-C.2d Wave 2 事故修复：memory Home Node **信封**契约 ——
         `/memory/*` 走 mobile-gateway 的 okBody() 信封（{ok,type,…,payload}），
         而桌面聊天面是裸对象；createMemoryRemote 曾按裸形状读取，
         导致 hydrate 读到 undefined.records 后 replaceAll([]) 清空镜像、
         sync 读 res.upserts.length 抛 TypeError。
         逐端点断言解包正确 + 失败响应绝不被解包成成功（mock fetch 驱动真实 remote）。 */
      ['test_home_node_client_envelope.js'],
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
      ['test_role_dm.js'],
      /* Peer Awareness Phase 1：角色公开认知层（Public Character Profile）。
         纯 Node、零浏览器、零网络：契约是纯函数，证据也该是纯的。
         覆盖公开资料归一化/可选/畸形/有界、旧角色零 migration 的 fallback 优先级、
         Self-private ≠ Peer-visible 的**构造式**边界（新字段默认不可见）、
         prompt 组装三层独立（对方是谁 / 我怎么看你 / 聊过什么）、
         prompt-injection 消毒与反例、唯一真源与非 IO 断言、DB_VER 未变。 */
      ['test_public_profile.js'],
      /* Role DM Phase 4B-1.2：人类显式披露写入路径（Disclosure Authoring Seam）。
         纯 Node、零浏览器、零真实模型调用：契约层是纯函数；持久化层用内存 mock 的
         IndexedDB 适配器；最关键的"模型看不到它"三条则跑**真实生产路径**——
         真实的 role-dm.js _composeSide（逐字节不变）、真实的
         memories → buildMemoryContext 读取链（正文一字不出现在上下文里）、
         真实的 run/turn（模型调用次数不变）。
         覆盖 create/update/delete/分区/roundtrip、owner 绑 writer context、
         caller 无法伪造 owner/source/authority、PUBLIC 被拒、A/B 隔离，
         以及 5 组 mutation（owner 取 peer / caller 传 authority / 允许 PUBLIC /
         秘密进 composeSide / 秘密复制进 memories）各自的变红证明。 */
      ['test_disclosure_authoring.js'],
      /* Role DM Phase 4B-2A：披露**授权**判定核（Hard Disclosure Authorization Kernel）。
         纯 Node、零浏览器、零真实模型调用：判定本身是纯函数；"判定不走关系分数"
         由去注释/去字符串后的源码结构断言钉住；"授权存在、消费不存在"由三段
         真实生产路径证明——真实的 composeSide 在两个方向上都逐字节不变、
         真实的 memories → buildMemoryContext 读取链不变、真实 run/turn 的
         模型调用次数在**两个独立子进程**里完全相同。
         覆盖 default deny（畸形 fact / 缺 owner / 缺 recipient / 未知 level）、
         三档 × grant 矩阵、有向性（A→B / A→C / B→A）、grant 生命周期
         （删除 / 文本 / level 提升 / subject 变更）、trust·familiarity·affinity·
         Memory ACL·provenance 全部**无法**授权、结果里没有正文、
         6 组 mutation（trust gate / 缺 grant 放行 / grant 忽略 recipient /
         ACL 当授权 / ALLOW 后自动注入 prompt / 未知 level 回落 PERSONAL）。 */
      ['test_disclosure_authorization.js'],
      ['test_role_dm_smoke.js'],
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
      ['test_fresh_install_data_loss_guard.js'],
      ['test_recovery_engine.js'],
      ['test_p32_w5_composite_recovery_plan.js'],
      ['test_p32_w5_composite_authority_revision.js'],
      ['test_p32_w5_composite_recovery_adapter.js'],
      ['test_recovery_planner_diagnostics.js'],
      ['test_recovery_dependency_analysis.js'],
      ['test_recovery_only_host_contract.js'],
      ['test_p32_w5_recovery_network_zero.js'],
      ['test_p32_w5_apply_executor.js'],
      ['test_recovery_production_adapter.js'],
      ['test_p32_w5_target_snapshot_manifest.js'],
      ['test_p32_w5_p5_8_6_recovery_preview.js'],
      ['test_p32_w5_r3_c3_4_executor.js'],
      ['test_p32_w5_r3_c3_5_production_reconstruction_adapter.js'],
      ['test_recovery_ui_state_machine.js'],
      /* U1：更新清单契约（Stable 通道 schema / 唯一 URL 构造 / 客户端校验与解析），
         纯 Node、不联网、不安装。真实构建期的清单断言在 test_installer_build.js --force。 */
      ['test_update_manifest.js'],
      /* U2：更新检查运行时（primary/API 回退门、唯一 semver 比较、24h 缓存、
         手动绕过、fail-open、GET /__update-check 端点）。纯 Node、不联网
         （transport 全部注入；唯一的服务器测试 patch 掉 checkShared）。 */
      ['test_update_check.js'],
      /* U3：更新安装运行时（U-D6 载荷回退门 / Content-Length·size·sha256·PE 版本
         四道校验 / 载荷绝不落进 {app} / detached spawn + helper 立即退出 /
         安装状态文件 / POST /__update/start 只接受版本确认）。纯 Node、不联网
         （载荷传输全部注入，不构建也不运行任何安装包；唯一的真实进程测试只
         启动 node.exe 以证明 detached 子进程比父进程活得久）。 */
      ['test_update_install.js'],
      /* U3：安装包 PE 版本资源读取（真实 node.exe + 合成 PE32/PE32+ 与具名损坏），
         纯 Node、不联网、不安装。 */
      ['test_pe_version.js'],
      /* U4：诊断页更新卡片（只渲染：不重实现 manifest/semver/传输/回退/sha256/PE/
         spawn/状态机；三端点逐字对齐服务端路由；八种状态 + 真实字节进度 +
         notes XSS 防护 + installing 之后断开不误报 + 一次性成功标记 +
         用户文案禁底层术语）。纯 Node：DOM 用最小 shim，fetch 注入，
         不联网、不开浏览器、不安装。 */
      ['test_update_card.js'],
      /* P12：Image Router / Image Scheduler 专项（纯 Node，确定性并发/优先级/失败恢复） */
      ['test_image_router.js'],
      /* P13：图片编辑 / 参考图解析专项（归一化/限额/选源优先级/lineage/多轮 A→B→C/edit 路由） */
      ['test_image_edit.js'],
      /* P15：Image Router 配置层专项（唯一模型目录 / 路由解析 / 能力过滤 / 备用通道 / 错误文案） */
      ['test_image_router_config.js'],
      /* U5-2A：欢迎页画窗背景 payload 闭合（PNG 源留在仓库、压缩副本入包、
         探测顺序冻结、真实静态服务 200、安装态 PNG 缺失时 JPG 回退 200、
         真实 staging 不含 PNG）。纯 Node：不联网、不开浏览器、不安装、不构建。 */
      ['test_welcome_canvas_payload.js'],
      /* P22-1：Agent Economy 领域契约（虚拟经济与真实货币/provider 余额的
         硬边界）。两组刻意分开 —— "契约说了什么"与"生产代码有没有照做"
         是两个不同的问题，混在一起会让失败信息无法区分。
           ① domain contract：币种白名单/拒绝、BigInt 金额表示、
              Wallet 三态（COLD/DEGRADED != 零余额）、交易状态机与终态不可回退、
              复式记账平衡、商品 effect 白名单（无任意代码/记忆/关系/provider 充值）、
              预算输入白名单（raw prompt / persona / maxBudget 一律拒绝）、
              报价过期、封闭 reason code、事实事件 envelope、依赖矩阵。
           ② boundary：Economy 生产文件的**依赖闭包**不得触及真实支付
              （pay-gate / alipay-provider / payment-provider / payment-auth /
              shopping-execution / credential-vault）、不得触凭据表
              character_runtime_specs、不得 require Memory/Relationship/
              Middle Brain/Provider Router；正反两条方向都要成立；
              并且这些文件真的进得了发行包（release manifest 逐文件白名单）。
         纯 Node：不联网、不开浏览器、不启动服务、不写盘。 */
      ['test_p22_1_economy_domain_contract.js'],
      ['test_p22_1_economy_boundary.js'],
      /* P22-2：Agent Economy 的**第一块 canonical runtime**
         （SQLite Ledger + 从 ledger 派生的 Wallet 余额）。
         两组刻意分开：
           ① store：账本本身对不对 —— lifecycle / 独立 schema 与 revision
              命名空间 / Wallet 三态（COLD/DEGRADED ≠ 0 余额）/ 复式记账
              逐币种平衡 / BigInt↔十进制字符串↔SQLite INTEGER 三层表示与
              MAX_SAFE_INTEGER 边界 / 幂等（重放、冲突、txId≠key、跨重启）/
              **故障注入**下的原子回滚（0 残留行、0 幻影余额、revision 不断）/
              close→open 持久性 / schema 新版本拒绝打开 / rebuild 从 ledger
              恢复被改坏的缓存。
           ② runtime：**生产进程里到底有没有它** —— 两条装配路径
              （buildHomeNode 与生产 openAll）都真的 open，HTTP 只读面
              （/economy/health · /wallet · /ledger · /transaction · /changes），
              写路径 405 且不存在，/security 的 economyPolicy 可检查，
              以及**真实 spawn services/home-node-service.js**：进程起来 →
              /economy/health 200 + READY → 干净停机 → 同一库重启 →
              账本与 revision 原样 → 同一 idempotencyKey 跨进程重放
              不造成第二次 mutation。
          这一域在仓库里已经被"装配好了但 openAll() 没打开它"咬过三次
          （memory / understanding / moments），因此 ② 里那条真实子进程
          断言是本阶段最重要的机器证据。 */
      ['test_p22_2_economy_store.js'],
      ['test_p22_2_economy_runtime.js'],
      /* P22-3：Agent Economy 的 **reservation 与 operation 生命周期**
         （先锁资源、后执行、成功 commit / 失败 release / 超时 expire）。
         两组仍然刻意分开：
           ① reservation（canonical store 层）：operation 生命周期用
              P22-1 §8 的 TX_STATES，reservation 用 §12 的 RESERVATION_STATE
              （两张冻结词表各自是唯一真源，靠契约里的映射连接）；
              reservedBalance 的 canonical truth 是 **active reservation
              行**、缓存是派生量（破坏缓存 → 从行重建 → 留 RESERVATION_REBUILT
              审计）；available = ledgerBalance − Σactive，只在 READY 下存在，
              其余一律 null（fail closed）；reserve / commit / release /
              expire / fail 各自恰好一个 SQLite 事务，18 个故障点逐个注入
              证明"不存在 Ledger 已扣款而 Reservation 仍 RESERVED"；
              终态不可回退（commit 之后不能 release）；幂等按 scope 分离
              （同一个 key 在 reserve 与 commit 下是两件事）；schema 1 → 2
              的补表迁移不动既有账本一个字节。
           ② runtime：这一域在**生产进程里**可读（新增
              GET /economy/reservations · /economy/reservation），六个写方法
              一个都不在 HTTP 上（每条路径 POST → 405），以及**多进程**
              竞争：4 个真实子进程在同一墙钟时刻同时 reserve，断言
              Σactive ≤ ledger 且"恰好 2 个成功"。这一组当场抓到并修好了
              一个真实缺陷：缺省 id 生成器在多进程同毫秒下会撞车。 */
      ['test_p22_3_economy_reservation.js'],
      ['test_p22_3_economy_runtime.js'],
      /* P22-4：Agent Economy 的**预算规则**与**报价**层 ——
         "这项经济行为在当前规则下是否允许"以及"如果执行要锁定多少"，
         但仍然**不真正执行购买**。三组刻意分开：
           ① budget：确定性评估器本身。它是**纯函数**
              evaluateBudget(policy, context) → ALLOW / DENY /
              REQUIRE_APPROVAL；同输入同输出（跑一千次逐字节相同、键序
              无关、深拷贝无关、换掉 Date.now/Math.random 也无关）；
              输入键受 P22-1 §13 白名单约束，因此 prompt / persona /
              relationship / LLM 输出**没有地方可以放**；评估顺序被冻结成
              11 步，于是同一输入只可能得到一个 reasonCode；窗口累计
              spentToday/Week/Month **只从 committed ledger facts** 算
              （UTC 日/周一起/月边界，跑过 23:59→00:00、周界、月界、
              重启），reserve 之后 release/expire/fail 都不会永久吃掉
              预算；fail closed：引用链断了/缓存坏掉一律 available=null +
              DENY + systemFailure，绝不返回 0、绝不伪装成"余额不足"；
              政策变更与评估都**不是**经济运动（ledgerMutation:false）；
              八个故障点逐个注入证明不留部分政策；schema 2 → 3 补表。
           ② quote：**价格命题 ≠ 资源锁定**。连开三份总额超过可用余额的
              报价之后账本/预留/available 逐字未变（并有一个"真的
              reserve 时指纹确实会变"的对照组，证明前一条不是假绿）；
              评估一份报价**不消费、不锁定**（两千次评估之后世界不变）；
              金额/币种/买家不可变（静态扫 UPDATE 的 SET 列 + 运行时
              篡改派生列会被完整性检查抓住）；终态不可回退；到期是一个
              比较而不是定时器；七条 API_QUOTA / COMPUTE_CREDIT 兼容性
              断言证明模型今天就能表达"买算力额度"而 provider 一个字节
              都没碰。
           ③ runtime：**生产进程里到底有没有它**。五条新只读路由
              （GET /economy/policies · /policy · /budget · /quotes ·
              /quote?evaluate=1）走真实 server；十条路径 × 三种写动词 =
              30 次写尝试全部 405 且世界逐字未变；/security 的
              economyPolicy 把 P22-4 的"没有"写成可检查字段；以及**真实
              spawn services/home-node-service.js**：进程起来 → 新路由
              200（不是 501）→ 干净停机 → 同一库再起一个进程 → 政策与
              报价逐字读回、revision 不动。 */
      ['test_p22_4_economy_budget.js'],
      ['test_p22_4_economy_quote.js'],
      ['test_p22_4_economy_runtime.js'],
      /* P22-5：Agent Economy 的**货架 / 商品目录 / 库存**层 ——
         "有什么可以买""一份商品是什么""谁拥有什么"，并且把 P22-4 的
         报价第一次接到**真实商品**上。三组刻意分开：
           ① catalog：Store 只是组织方式（没有价格、没有拥有关系），
              Product 是"可报价的商品定义"（kind → fulfillment / assetKind
              派生、单价必须带单位、免费商品是**显式**合法值而"忘了写价格"
              是另一种失败），创建 product-backed 报价时调用方**没有地方**
              传金额（amountMinor/currency/quantity/kind 全部从商品行派生）；
              以及本阶段最要紧的一条：**改价不重写历史** —— 商品 100 → 120
              之后旧报价逐字节不变、新报价是 120（"改价的语句里没有状态列、
              改状态的语句里没有价格列"由静态扫 SET 列钉住）；disable /
              retire 只让**新**报价被拒，历史报价与已有库存一个字都不动；
              创建报价的世界指纹前后逐字相同（含"真的 reserve 时指纹确实
              会变"的对照组）；九个故障点逐个注入；schema 3 → 4 补三张表且
              拒绝更新的库时**一张表都不补**；Gift / API_QUOTA / SERVICE
              三个 fixture 证明 schema 没被写死成"只能表达 RPG 物品"。
           ② inventory：**canonical 就是那一行，没有派生缓存**（因此没有
              rebuild、也没有开库对账 —— §17 要求先判断需不需要），grant
              10→10 / 5→15、consume 8→7 / 再 8 被拒且数量仍是 7、同 key
              重放不变、同 key 不同数量是冲突、GRANT 与 CONSUME 是**两个**
              scope（同一 key 在两者下不是同一件事）；多 owner 隔离（A 消耗
              不动 B，且 listInventory 拒绝"全局列库存"）；11 种非法数量
              逐个拒绝且零痕迹；两个独立连接的并发恰好一个成功、20 轮双向
              竞争最终恰好为 0 且**永不为负**（CHECK + 守卫 + BEGIN IMMEDIATE
              三道防线）；库存 ≠ 钱包两个方向都证（grant 不动余额、铸币不动
              库存）；商品 retire 之后库存仍在、quantity=0 的行保留、静态
              断言生产代码里没有 DELETE FROM stores/products/inventory。
           ③ runtime：**生产进程里到底有没有它**。六条新只读路由
              （GET /economy/stores · /store · /products · /product ·
              /inventory · /inventory-entry）走真实 server；十条路径 × 三种
              写动词 = 30 次写尝试全部 405 且目录/库存/报价/账本逐字未变；
              /security 的 economyPolicy 把 P22-5 的"没有"写成可检查字段；
              配了桌面 token 时六条新路由一律 401；以及**真实 spawn
              services/home-node-service.js**：生产进程读到的货架/商品/库存
              与播种时逐字相同，生产进程上的 POST 同样是 405；最后是
              P22-3 那条纪律换到库存上：**四个真实子进程**在同一墙钟时刻
              同时 consume 8（库存 20），断言恰好 2 个成功、最终数量恰好 4
              且每个 worker 自己读到的数都 ≥ 0。 */
      ['test_p22_5_economy_catalog.js'],
      ['test_p22_5_economy_inventory.js'],
      ['test_p22_5_economy_runtime.js'],
      /* P22-6：Purchase Orchestrator + Atomic Settlement —— 第一次把
         Product → Quote → Budget → Reservation → Ledger → Quote 消费 →
         Inventory/Compute 交付串成**一条**经济流程。
         三组刻意分开：
           ① purchase：域契约与 Prepare。Purchase 的四态状态机（终态不可逆、
              初始态只有 RESERVED）、身份复用 P22-1 冻结的 PURCHASE_INTENT
              （ID_KINDS 仍然是 14）、结算映射（fulfillment → primitive →
              frozen TX_TYPE）、结算对手方来自 SYSTEM_ACCOUNTS 白名单且
              **不是** MINT（一次购买不是一次增发）。Prepare 成功之后世界
              逐字是：Purchase RESERVED / Reservation ACTIVE / Quote **仍然
              OPEN** / Ledger 与 Inventory **一字节未动**（余额只是被锁）；
              幂等的 prepare 重放不产生第二次 reserve；Product-backed 强制
              （悬空引用、金额不符、收件人不符全部拒绝）；商品改价 / disable
              / retire **不改变**已 Prepare 的购买（历史报价的有效性只由它
              自己的 state 与 expiresAt 决定）；SERVICE 在 Prepare 就
              fail closed 且**不 reserve**；静态边界：零 provider / 零支付 /
              零 Memory / 零 Relationship / 零 Decision / 零 Action。
           ② settlement：**一个 SQLite COMMIT 边界**。13 个故障点每一个都
              断言七件事（ledger 未扣款 / reservation 仍 ACTIVE / quote 未
              被消费 / inventory 未增 / purchase 未假完成 / revision 未泄漏 /
              幂等无残留）并且有 **hit counter** 证明"注入了的确实被执行过"；
              transactionDepth 观测证明所有结算步骤都在**同一个**事务里；
              普通 / Gift（A 付款、B 收货、ledger 的 payer 是 A）/ Compute
              （内部 computeUnit 额度真的 +1000，而 provider 零参与）/
              Service 四条完整路径；exactly-once（一次购买至多一笔交易、
              至多一次发放、一份报价至多一次成功消费）；取消**不产生退款**
              也不取消报价；报价或预留在 Prepare 之后过期 → 拒绝 + 释放 +
              终态，且 quote 进入 EXPIRED；预算的**最终**再评估（Prepare
              ALLOW、settle 时政策改严 / 窗口被别处用掉 / 变成
              REQUIRE_APPROVAL / 政策失效 —— 四种都 fail closed，且
              REQUIRE_APPROVAL 进 RELEASED 而不是 FAILED）。
           ③ runtime：**生产进程里到底有没有它**。两条新只读路由
              （GET /economy/purchases · /purchase）走真实 server；八条购买
              写路径 × 三种写动词 = 24 次写尝试全部 405；/security 把
              purchaseWritesExposed / settlementWritesExposed /
              policyApprovalWritesExposed 三条写面写成空名单；**真实 spawn
              services/home-node-service.js** 打开 schema 5 的库、重启之后
              同一条购买逐字相同；最后是 P22-3 那条纪律换到结算上：
              **两个真实子进程**在同一墙钟时刻同时 settle 同一次购买，
              断言恰好一笔 COMPLETED / 恰好一笔交易 / 恰好一次发放 /
              恰好一次报价消费（另一个是幂等回放或终态冲突，绝不是双扣）；
              两个进程同时 prepare 同一份报价 → 最多一条成功；6 个进程各自
              prepare 得到 6 个互不相同的 purchaseId。 */
      ['test_p22_6_economy_purchase.js'],
      ['test_p22_6_economy_settlement.js'],
      ['test_p22_6_economy_runtime.js'],
      /* ── P22-7 · Approval + Autonomous Purchase Policy ────────────────
         authority 层（"Agent 有没有权不问用户直接花"）的完整运行时：
         两条链（AUTO_ALLOW / APPROVAL）、五态批准记录、九元组绑定、
         一次性消费、self-approval 拒绝、以及 HTTP 仍然零写路由。
            autonomy  —— 契约与**纯策略**：三个结论、十条判据的冻结顺序、
                          no-policy fail closed、§3 的 Budget×Autonomy 两层
                          边界、§6 的九元组绑定、Gift 与 Compute/API quota；
            approval  —— 批准记录的生命周期：请求 / 决定 / 拒绝 / 过期 /
                          消费，§6 的"批准不能被挪给另一笔购买"，§8 的
                          "一个批准最多一笔购买"，§11 的"批准不是预算豁免"；
            runtime   —— **真实 spawn services/home-node-service.js**（schema 6）
                          + 两条写面为空的只读权限面 + **两个真实子进程**
                          分别 APPROVE/REJECT 同一条批准（恰好一个写入者）
                          与同时拿同一条批准去买（恰好一笔购买）+
                          7 个注入点上的**真实进程崩溃**（exit 134）与回滚，
                          断言绝不出现「批准已 CONSUMED 但没有 Purchase」。 */
      ['test_p22_7_economy_autonomy.js'],
      ['test_p22_7_economy_approval.js'],
      ['test_p22_7_economy_runtime.js'],
      /* ── P22-8 · Agent Purchase Intent + Decision Bridge ───────────────
         第一次允许 Agent（模型）**提出内部购买意图**，而它只能提出"想买
         什么"，不能提出"多少钱 / 什么币种 / 打几折 / 批没批 / 走哪种结算"。
         三层各守各的边界：Agent 决定 WANT、P22-7 决定 MAY、P22-6 执行
         SETTLEMENT，而三者绝不合并。
            intent    —— 契约与**纯函数**（零数据库）：Intent 的七态状态机
                         与四条终态、§8 的三条禁令、§4 的经济事实拒绝清单
                         （含大小写与分隔符变体）、§3 的 reason≠authority、
                         §10/§11 的意图指纹（不含 reason、不含 expiresAt）、
                         指纹算法与 store 那一份**逐字相同**、
                         §5–§7 的裁决表与它的七条判据顺序；
            bridge    —— store 层的编排：Intent → Product-backed Quote →
                         P22-7 权威闸门 → 三条出口（AUTO_ALLOW 直通 P22-6 /
                         REQUIRE_APPROVAL 停在批准 / DENY 终结）、§7 的批准
                         恢复路径（同一份报价、不问模型第二次、批准不复活
                         过期报价）、§10 的重复窗口、§11 的跨重启幂等、
                         §12 Gift 与 §13 Compute quota、§17 的可解释链、
                         以及"那张表里没有地方可以读价格"的列级断言；
            runtime   —— **真实 spawn services/home-node-service.js**（schema 7）
                         + 两条只读路由（GET /economy/intents · /economy/intent）
                         与六十次写尝试全部 405 + **两个真实子进程**同时提
                         同一份模型输出（最多一条 Intent、一笔购买、一次
                         资金动作）与同时恢复同一条 APPROVED Intent（最多
                         消费一次批准）+ §16 点名的**六个边界**上的真实
                         process.abort() 崩溃与恢复，断言绝不出现「钱花了但
                         没有 intent」「假完成」「丢失等待批准状态」。 */
      ['test_p22_8_economy_intent.js'],
      ['test_p22_8_economy_decision_bridge.js'],
      ['test_p22_8_economy_runtime.js'],
      /* ── P22-9 · Economy Capability Gate ────────────────────────────────
         在所有 runtime consumer 与 P22-8 之间加**唯一**一道确定性的准入
         门，而它刻意**不是** P22-8 的一部分：门在 store 上面，因此
         P22-6 ~ P22-8 的 canonical ownership 一行不改。
           capability —— 契约里的封闭词表（两个能力、三个消费者，每个消费者
                          带一个可核对的运行时锚点）、唯一真源的权限矩阵、
                          纯函数 checkEconomyCapability（不读时钟、不写任何
                          东西）、fail closed 的六类理由（缺身份 / 未知身份 /
                          缺能力 / 未知能力 / 被收回 / 损坏配置）、"配置只能
                          收窄"、以及**七位恒 false**（能力不是经济权威）；
           runtime    —— 真实装配（buildHomeNode 与进程级装配两条路径给出
                          逐字相同的矩阵）+ 真实 in-process HTTP（六条"授权
                          形态"的路径 × 四种动词全部 405、24 次尝试之后经济
                          事实逐字未变、/security 把它写成可断言字段）；
          ★ 本阶段**零子进程**：门是纯查表 + 一次调用，它的全部自有 invariant
          都是单进程可判定的，而唯一跨进程的性质（同一个提议在两个真实进程
          里恰好产生一条 Intent）属于 P22-8 的 store，已在 p22-8 的两进程组
          里证明过 —— §9/§10 明确不要在 P22-9 重做。 */
      ['test_p22_9_economy_capability.js'],
      ['test_p22_9_economy_runtime.js'],
      /* ── P22-10 · Economy Action Adapter ────────────────────────────────
         给现有 Agent / Action runtime 一个**极窄**的经济接口，使它只能
         经 P22-9 的 bound capability handle 提出购买意图，拿不到 raw store，
         也拿不到任何底层经济写能力（settlePurchase / reserveFunds /
         mutateInventory / ledger transaction / approveApproval …）。
           adapter  —— §2 封闭动作集（**只**开放 ECONOMY_PROPOSE_PURCHASE；
                        §9 的 resume 登记为"已知但不开放"，理由是生产代码里
                        decideApproval 的调用方数为 0 —— 没有"用户已批准"的
                        触发 seam）；§7 净化器（未知动作 / 畸形 proposal /
                        缺幂等键 / 白名单外的键一律拒绝，不猜修复）；§4 模型
                        不得提供九个经济事实（action 层由适配器列名拒绝、
                        proposal 层由 P22-8 以 MODEL_SUPPLIED_ECONOMIC_FACT
                        拒绝）；§3 传 store 进去**构造期就抛**、拒绝路径一个
                        句柄调用都不发（用一个一被调用就抛错的句柄证伪）；
                        §8 重复动作不重复购买而适配器里**零**去重状态；
                        §5 成功与拒绝带同一组恒 false 位；
           runtime  —— §6 只接 active_agent_runtime：真实装配（buildHomeNode
                        与进程级装配）都有已绑定的适配器、消费者锚点可核对
                        （component-registry#active → 23114）、Active 的既有
                        两条封闭动作集逐字未改且不含任何经济动词、Middle
                        Brain 零经济引用、只有 Active 一个消费者被 bind；
                        以及装配面端到端走完 P22-9 → P22-8 → P22-7 → P22-6。
         ★ 本阶段**零子进程**：动作净化是纯函数、转发是一次字面成员调用，
         全部自有 invariant 单进程可判定；P22-6 ~ P22-8 已经证明过的
         崩溃/竞争矩阵只做 regression，不复制（§12）。 */
      ['test_p22_10_economy_action_adapter.js'],
      ['test_p22_10_economy_active_runtime.js'],
      /* ── P22-11 · Active → Home Node Economy Command Channel ────────────
         P22-10 的审计留下了一个已确认的断点：Active 的决策运行时在 23114，
         而 canonical Economy store 只在 23118 被装配，两个进程之间**没有**
         经济通道（HTTP 上的经济写面从 P22-2 起就是 0）。P22-11 建立**一条**
         极窄的 command 通道：
           channel  —— 单进程 · 真实 HTTP（零子进程）：复用既有 transport
                        （loopback + 凭据 + 信封 + 有界 body），新增的只有
                        "来源登记"（每个来源自己的 token、只以 SHA-256 摘要
                        进索引、恒定时间比较、管道端口登记）与一条专用路径
                        `/internal/economy/command`。§3 payload 里出现
                        consumerId/consumer/capability/role/authority/approved/
                        autoAllow 任何一个 → 403 且**没碰适配器**；§2 只开放
                        ECONOMY_PROPOSE_PURCHASE（禁止的八个名字逐个断言
                        404；resume 在通道代码里一次都不出现）；§7 同一
                        requestId 重放收敛到同一条 Intent、不同 payload 复用
                        同一 id 则 409；§8 超时/重试有界，传输失败只能表达
                        DELIVERY_UNKNOWN / TRANSPORT_FAILED（绝不写成
                        purchase failed / denied）；未配置来源 ⇒ 503（fail
                        closed）；
           bridge   —— **两个真实进程**（Active companion 23114 的组合根 +
                       Home Node 23118 的生产启动路径）：一条 authenticated
                       Active command 真的跨进程建出一笔购买，重放不产生第二
                       笔，未知 command 跨进程被拒，普通 `/economy/*` 写面在
                       真实进程上仍然为 0，且两个进程的输出里都没有来源凭据。
         ★ §12 的进程纪律：**max concurrent child = 2 · total spawn = 2 ·
         0 leftover**，一对 fixture 的生命周期里跑完全部用例；单进程能证明
         的（认证 / 来源 / 信封 / 幂等 / 超时）一个 child 都不开。 */
      ['test_p22_11_economy_command_channel.js'],
      ['test_p22_11_economy_active_bridge.js'],
      /* ── P22-12 · Economy Intent Producer ───────────────────────────────
          P22-11 结束时留下了一句必须被兑现的话：动作在净化边界上被接受，
          但**今天没有任何生产代码会主动发出它**。P22-12 补上生产者 ——
          而且只补生产者：
            producer —— 单进程 · 真实文件（四个真实浏览器文件在一个 vm 沙箱里
                        按 InternalBeyond.html 的顺序求值）· 真实 in-process
                        23114 路由（createHttp 工厂）+ 真实 P22-11 通道客户端：
                        §11 真实 prompt（buildPlanPrompt）在**真的有目录事实**
                        时才宣告这个动作、§3 只给语义不给 authority（"你有权
                        购买/余额足够就买/预算允许/已批准/自动结算/有钱就花/
                        定期消费"逐句断言不存在）、§4 模型只能选四个意图字段
                        （二十二个经济事实 / authority 键逐个被拒，且净化器
                        代码里一个事实键名都没有——白名单而不是黑名单）、
                        §4 agentId 由本地角色配置注入而不由模型自报、§5 `none`
                        走完整条真实链之后零请求、§6/§7/§8 的语义边界、
                        §9 目录注入只有六个只读事实（价格/币种/发放数量不进
                        prompt）、§10 同一份模型输出两次 → 同一个 canonical
                        身份（两条腿：幂等 + P22-8 的 60s 指纹窗口）、
                        §12 malformed / 偷渡 / 不可达一律 fail closed 且
                        transport unknown ≠ purchase failed；
            plan     —— 边界与 authority：只扩 active_agent_runtime（bind 仍然
                        恰好一处）、九个禁止动作名零出现、生产者零经济句柄 /
                        零 require / 零 23118、闸门只有一个写入点且由 companion
                        的 /health 驱动（默认 false）、批准面没有被顺手打开、
                        目录走**既有** GET /economy/products 且投影是构造式的、
                        经济侧四份文件完全不认识生产者。
          ★ §12 的进程纪律：**max concurrent child = 0 · total spawn = 0 ·
          0 leftover**。P22-11 已经用两个真实进程证明过跨进程通道，本阶段
          不再重跑那套证明；所有自有 invariant 都是单进程可判定的。 */
      ['test_p22_12_economy_intent_producer.js'],
      ['test_p22_12_economy_active_plan.js'],
      /* ── P22-13 · Economy Approval Decision Path ────────────────────────
          P22-12C 的 Closure Audit 留下的唯一 Backend Core blocker（B1）：
          `decideApproval` / `resumeAgentPurchaseIntent` /
          `resumeApprovedPurchase` 三者在**生产代码里**的调用方都是 0，
          于是默认部署（AUTONOMY_DEFAULT_WHEN_NO_POLICY = REQUIRE_APPROVAL）
          下每一条 Agent Intent 都停在 WAITING_APPROVAL 且**没有任何生产路径**
          能把它推到终态。P22-13 补上这一段，而且只补这一段：
            decision —— 单进程 · 真实 store + 真实门 + 真 seam：§2/§3 决定
                        词表恰好两个（BUY/SETTLE/RESERVE/GRANT/REFUND/LEDGER/
                        AUTO_ALLOW/FORCE_APPROVE 逐个断言：它们在这份代码里
                        **不存在**）；信封恰好三个键、身份键逐名拒；§4/§5
                        APPROVE 只能走既有 resume 链（一个探针句柄证明 resume
                        恰好被调用一次、入参只有 canonical 两个键），REJECT
                        零 Ledger / Inventory / Settlement 且不再 resume；
                        §6 single-use / 过期 / CONSUMED / 错误配对全部由
                        P22-7 的状态机回答（本阶段不造第二套）；§7 重试
                        exactly-once、同身份换决定词 conflict；§8 approved
                        之后 Budget / Quote / intent 有效期仍然是权威
                        （APPROVED → resume → FAILED / DENIED 是合法结局）；
            runtime  —— 真实 buildHomeNode + 真实 server + 真实 fetch：
                        一条 authenticated 的用户决定真的建出一笔购买；
                        没有桌面凭据 / 凭据不对 / 拿来源凭据一律被外层挡住；
                        出示正确凭据但自报身份 ⇒ 403 且没碰 store；
                        普通 /economy/* 写面仍然**为 0**（八条写形态逐个
                        405 economy-is-read-only）；/security 把这条新面写成
                        可断言字段，且与 command 通道**不共用** consumer 与凭据。
          ★ §12 的进程纪律：**max concurrent child = 0 · total spawn = 0 ·
          0 leftover**。本阶段没有任何必须跨进程才能证明的新身份 invariant
          （身份分离是结构性的，single-use 是 P22-7 的两进程组已经证明过的），
          因此一个 child 都不开，也不重跑 P22-6 ~ P22-8 的 race/crash matrix。 */
      ['test_p22_13_economy_approval_decision.js'],
      ['test_p22_13_economy_approval_runtime.js'],
      /* P24-M3.1 · Participation Contract + Deterministic Rule Planner —— 纯规则 planner：
         WHO GETS A MEMBER TURN（SPEAK / omitted），reason 闭集，order = planned
         participant order（空洞合法），runtime-only（沉默不是消息），fail closed
         （重复 id / 未知 status / 非法 id ⇒ contract error），无时钟无随机无存储无 P23 字段。
         本阶段**不接管生产**（communication.js 零修改）。纯 Node、零浏览器、零网络。 */
      ['test_group_participation_planner.js'],
      /* P24-M3.3.3.1 · Recent Speaker Derivation —— 纯 helper（capability only）：
         canonical ordered history snapshot → recentSpeakerIds（most-recent-first）。
         window 单位 = MemberTurn（turnId dedupe：multipart / 工具续轮只占 1 slot）；
         只有 resolved 且属于当前 participants 的 assistant 消息消耗 window；
         身份只经 M2 resolveSpeakerId（ambiguous/unresolved/非本群 一律忽略）；
         输出 speaker 去重、不含 content/turnId/messageId。**不改 planner / 不改生产**。 */
      ['test_group_recent_speakers.js'],
      /* P24-M3.4.1 · Participation Policy Resolver —— 纯 resolver（capability only）：
         group explicit > user default > system default 的**逐字段**优先级；allowed fields
         闭集（maxResponders / recentSpeakerWindow = 非负有限整数）；absence 不物化默认值、
         显式 0 是真值；非法 fragment / unknown field / prototype trick 一律 fail closed
         （绝不 fallback 到低优先层）；sources 仅诊断；零存储零网络零 DOM。
         **不接 production**：communication.js / social.js / planner / recent helper 零修改。 */
      ['test_group_participation_policy.js'],
      /* P25-1 · Autonomy Core Foundation（**纯裁决层**，零业务接入）：
         Action Candidate → Context Evaluation → Decision → Executor → Result Trace。
         闭集：actionType（moment.post/diary.write/active_message.send/activity.start 占位）、
         source、decision（allow/deny/defer）、reason、errors。hard gates（非法 action / cancelled /
         duplicate / cooldown / 无 executor）先于可选 decider；decider 抛错或返回未知词 ⇒ **DENY**
         （裁决失败绝不执行）；只有 allow 才调用 executor，executor 抛错被捕获不上抛。
         trace 仅内存（环形上限，memory=false / persist=false）、时间由 ctx.now 注入（无时钟/随机）。
         零 provider / 零模型 / 零 Memory / 零 Middle Brain / 零 Group Brain / 零持久化；
         P24（group-runtime-core / communication）零耦合。纯 Node、零浏览器、零网络。 */
      ['test_autonomy_core.js'],
      /* P25-2A · Moments Autonomy Adapter Foundation（P25 第一次**真实业务**接入）：
         Candidate → (test-injected) Recommendation → fail-closed Moments policy →
         P25 Autonomy Core（**永远显式 ctx.decide**，绝不依赖 Core 的 default-allow）→
         Executor Bridge → Moments creation authority。闭集：source（schedule/character，
         user 显式拒绝）、recommendation（post/skip）、reasonCode、adapter reason；
         missing/malformed/未知词/策略抛错/读口失败 ⇒ DENY（fail closed）；
         allow 才执行且恰好一次，执行失败是 ok:false 而**不是** DENY；DEFER 不排队不重试。
         同时收敛 Moments 的**唯一**落盘通道（_momentsWriteCanonical）：mirror/local
         与 Home Node canonical 都合法，canonical 下不再触发 moments-write-closed；
         candidateId → 稳定 Moment id ⇒ 同一候选重试只有一行（幂等 ≠ 文本相似度）。
         测试在 Node 里真实加载 moments.js（vm 沙箱 + 真实 moments-authority +
         真实 canonical store），并守卫 P23/P24/Autonomy Core 的冻结 hash。
         纯 Node、零浏览器、零网络、零真实 provider。 */
      ['test_moments_autonomy.js'],
      /* P25-2B · Moments Semantic Recommendation：
         "一次模型调用同时返回 publish + content" 收敛成"一次模型调用返回结构化
         recommendation + draft"。闭集：recommendation（post/skip，模型**不能**返回
         allow/deny/defer）、reasonCode（post 词表 / skip 词表，方向错即 malformed）、
         禁推理字段（thinking / analysis / reasoning / rationale / explanation 出现即
         malformed，绝不保存、绝不进 trace）。topicKey → normalize → stableToken ⇒
         topicFingerprint：改措辞不改指纹，换话题才换身份；模型不拥有 candidate identity。
         旧 `publish:true/false` 只作为**一处**兼容 seam 投影进新契约（publish:true ≠ ALLOW）。
         semantic → finalizeCandidate → runMomentAutonomy → executor → canonical writer
         的真实组合在 Node 里跑通（真实 moments.js vm 沙箱 + 真实 moments-authority +
         真实 canonical store），并守卫 P23 / P24 / Autonomy Core / active-diary /
         active/moments.js 的冻结 hash 与"scheduler 仍未接 adapter"。
         纯 Node、零浏览器、零网络、零真实 provider。 */
      ['test_moments_semantic_recommendation.js'],
      /* P25-2C · Scheduler / Trigger Migration（P25-2 的最后一个生产接线阶段）：
         调度器不再拥有 permission authority —— 它只产出 **Candidate Seed**
         （deterministic triggerRef：schedule:<nextAt 槽位>，无 Date.now / Math.random），
         然后走 semantic → finalizeCandidate → runMomentAutonomy →（ALLOW）→ 图片 →
         executor → createMoment 的唯一管线。图片生成时机整体后移到 ALLOW 之后：
         skip / DENY / DEFER 的 image router 调用数 = 0。频率 / 最短间隔 /
         declineStreak / 多标签 claim 互斥 / 手动触发无冷却全部逐字保留；
         legacy `publish:true` 只剩投影，绝不再是写入许可；同一 candidate 重试仍只有一行。
         测试在 vm 沙箱里加载真实 moments.js + semantic core + autonomy core + adapter
         （真实 canonical store / 真实 Image Router 桩），并守卫 Core / P23 / P24 /
         active-diary / active/moments.js 的冻结 hash。纯 Node、零浏览器、零网络。 */
      ['test_moments_scheduler_migration.js'],
      /* P25-2D · Companion Runtime Convergence（P25-2 的最后一个 runtime 收敛阶段）：
         companion 不再拥有发布许可 —— 它的模型输出走**与桌面同一份** semantic core
         （唯一 parser / 词表 / topic 归一 / fingerprint / 禁 CoT 字段 / draft 契约），
         只产出 **candidate + recommendation** 事件（trigger_ref = recurrence 槽位，
         无 Date.now / Math.random）；事件**不是许可**：浏览器 ingest 必须
         finalizeCandidate → runMomentAutonomy → ALLOW 才写，旧 envelope 同样受管辖。
         prefs / history / cooldown / canonical 写入仍由浏览器侧唯一权威提供；
         图片在 ALLOW 之后才生成（skip / DENY / DEFER 的 image router 调用 = 0）。
         companion 域仍零直接写入（createMoment / _momentsWriteCanonical 引用 = 0），
         手动 composer 仍零 autonomy，Core / P23 / P24 / active-diary 冻结 hash 不变。
         测试跑真实 companion service（模型打到本机 mock HTTP）+ 真实浏览器沙箱。 */
      ['test_moments_companion_convergence.js'],
      /* P25-2 · Moments Autonomy Closure / Freeze（Closure 阶段：只枚举 + 冻结 + 证明）：
         **生产创建路径枚举**（源码扫描得到每条 createMoment 调用点并按所属函数分类）——
         MANUAL_CREATE 是唯一允许绕过 Autonomy 的创建路径；两条 AUTONOMOUS_CREATE 只存在于
         executor 的写入桥里；companion 域 createMoment / _momentsWriteCanonical / dbPut 引用 = 0。
         冻结：语义 v2 契约（推荐 ≠ 许可）、closed reasonCode、共享 semantic core、
         candidate identity（无 Date.now / Math.random / 到达时间）、triggerRef 语义、
         ALLOW-only 执行、image-after-ALLOW、唯一 canonical writer、唯一 prefs 权威、
         canonical 历史权威、no-CoT、secret 边界、DENY/DEFER 零写零图。
         并断言 mutation authority debt（点赞/评论/删评/删除）单独归类、DB_VER / moments schema /
         P23 / P24 / Autonomy Core 全部未因 P25-2 改变。纯 Node、零浏览器、零网络。 */
      ['test_moments_autonomy_closure.js'],
      /* P25-2.5 · Moments Mutation Authority（创建权限 ≠ 修改权限）：
         点赞 / 取消点赞 / 评论 / 回复 / 删评 / 删动态都必须先过 Mutation Authority 的
         decision，只有 ALLOW 才执行写入 —— 禁止 UI event → dbPut 的直达边，
         禁止 companion / AI 自己写。闭集词表（mutationType / source / decision / reason），
         actorId 必须在 canonical identity 域（apiConfigs.id / user principal，displayName 拒绝）。
         与 Autonomy 刻意分开：like/comment 绝不进 runMomentAutonomy；Autonomy Core 与
         canonical writer / DB schema / P23 / P24 全部保持不变。纯 Node、零浏览器、零网络。 */
      ['test_moments_mutation_authority.js'],
      /* P25-3A · Unified Agent Orchestration Foundation（**不接生产**）：
         Intent → Observe → Plan → Capability Resolution → Authority Routing（只声明，
         由 domain 裁决）→ Execute（executor 注入）→ Verify（只定义 contract）→ Reflect
         （结构化 summary）。三件纯模块：capability registry（只存 metadata + binding key，
         不裁决/不执行/不含凭据与函数）、orchestration core（Plan != Permission、
         denied ≠ failed、deferred ≠ failed、取消不回滚已完成、依赖 DAG 无环、
         side-effect 不自动 retry、idempotencyKey 只透传、零持久化/零 provider/零 CoT）、
         Moments reference adapter（moment.post → P25-2 Autonomy；moment.like/comment/reply/
         comment.delete/delete → P25-2.5 Mutation Authority）。纯 Node、零浏览器、零网络。 */
      ['test_agent_capability_registry.js'],
      ['test_agent_orchestration_core.js'],
      ['test_agent_orchestration_moments_adapter.js'],
      /* P25-3B · Diary Capability Integration（**第一个真正实现 verifier 的 capability**）：
         Trigger → Diary Candidate → **Diary Authority** → ALLOW → Diary Executor →
         Canonical Writer → Verifier。冻结：PLAN != PERMISSION · MODEL OUTPUT != PERMISSION ·
         SCHEDULER TRIGGER != PERMISSION · CAPABILITY AVAILABILITY != PERMISSION。
         新增两个纯/边界模块：diary-authority（唯一写权限；闭集 source（schedule/character/user）
         与 decision（allow/deny，**无 DEFER**）；facts 只有 actorKnown/enabled/hasContent/cancelled，
         缺一律 DENY；零 DB / DOM / 模型 / Memory / Middle Brain / 秘密 / CoT）与
         agent-orchestration-diary-adapter（diary.write descriptor = domain authority，
         只登记 + 路由 + 透传 idempotencyKey，绝不自己写库/调模型）。
         Production convergence：legacy scheduler 的 generateDiaryEntry 收敛为
         model → Diary Authority → ALLOW → _diaryWriteCanonical，authority 缺席即 fail closed；
         _diaryWriteMemory 仍是 canonical write **之后**的 secondary side effect
         （Memory 失败不得把已写成功的日记伪装成失败）；identity / duplicate / frequency /
         prompt / 模型调用次数 / UI / P23 / P24 / Autonomy Core 全部未改。
         第二个套件在 vm 沙箱里加载真实 diary.js 生产链（内存 store 桩），
         含 verifier（canonical 行不存在 ⇒ verification failed，不补写、不 retry）。
         纯 Node、零浏览器、零网络、零真实 provider。 */
      ['test_diary_authority.js'],
      ['test_agent_orchestration_diary_adapter.js'],
      /* P25-3C · Active Message Capability Integration（主动消息：**发送**权限唯一权威）：
         Trigger → Active Message Candidate → **Active Message Authority** → ALLOW →
         Executor → Canonical Chat Write → Verify。冻结：PLAN != PERMISSION ·
         MODEL OUTPUT != PERMISSION · SCHEDULER TRIGGER != PERMISSION ·
         CAPABILITY AVAILABILITY != PERMISSION。
         新增两个模块：active-message-authority（闭集 source（schedule/plan/character/user/
         companion）与 decision（allow/deny，**无 DEFER**）；判定顺序 invalid-candidate →
         unknown-actor → unknown-target → cancelled → disabled → quiet-hours → cooldown →
         duplicate → allow；零 DB / DOM / 模型 / Memory / Middle Brain / Notification / TTS /
         秘密 / CoT）与 agent-orchestration-active-message-adapter（active_message.send
         descriptor = domain authority，只登记 + 路由 + 透传 idempotencyKey）。
         Production convergence：设定计划（scheduler）/ AI 计划 / 手动"立即发送"三条路径
         都收敛到 _activeSendAuthorized → authority → ALLOW → 唯一 canonical writer
         _activeWriteCanonical（域内只剩一个 dbPut('chatMessages')）；companion 事件是
         **投递镜像**（inbound，不重复裁决发送权限）。免打扰 / 冷却 / 去重 / 频率规则
         仍然只有一份（BG-AI 休眠窗口 / 12 小时互动顺延 / 相似度 0.82），未被改写。
         第二个套件在 vm 沙箱里加载真实 active-diary.js + active-plans.js（内存 store 与
         最小 IndexedDB 桩），驱动真实 _activeTick → _activeClaimDue → _activeExecuteRun。
         纯 Node、零浏览器、零网络、零真实 provider。 */
      ['test_active_message_authority.js'],
      ['test_agent_orchestration_active_message_adapter.js'],
      /* P25-3C-Node · Active Message Companion Runtime Convergence：
         Node companion 的发送出口（active/scheduler.js 的 executeTask / executePlan）
         不再自行判断 send —— candidate + 既有 facts（BG-AI 休眠 / 12 小时顺延 /
         model-client 0.82 去重）交给与 Browser **共用的同一个**
         assets/js/active-message-authority.js；ALLOW 才走既有出口
         （事件 / 历史 / windowsNotify），DENY 记 skipped（任务）/ canceled（计划），
         权威缺席 ⇒ fail closed。scheduler 时序 / claim / retry / 免打扰语义未改。
         本套件用真实 service 执行链（隔离数据目录 + global.fetch 场景桩）覆盖
         NC1–NC10；纯 Node、零真实网络、零真实 Key、零 OS 通知。 */
      ['test_active_message_node_convergence.js'],
      /* P25-3D · Role Letter Capability Integration（AI↔AI 私信：**写信**权限唯一权威）：
         Trigger → Role Letter Candidate → **Role Letter Authority** → ALLOW → Executor →
         Canonical roleLetters Writer → Verify。冻结：PLAN != PERMISSION ·
         MODEL OUTPUT != PERMISSION · SCHEDULER TRIGGER != PERMISSION ·
         CAPABILITY AVAILABILITY != PERMISSION。
         新增两个模块：role-letter-authority（闭集 source（schedule/character，**没有 user/manual**：
         仓库里不存在用户直接写 Role Letter 的入口）与 decision（allow/deny，**无 DEFER**）；
         判定顺序 invalid-candidate → unknown-actor → unknown-recipient → cancelled → disabled →
         cooldown → duplicate → allow；零 DB / DOM / 模型 / Memory / Middle Brain / 通知 / 秘密 / CoT）
         与 agent-orchestration-role-letter-adapter（role_letter.write descriptor = domain authority）。
         Production convergence：cadence 写信（_rlInitStep）与读信后回信（_rlReplyStep）都收敛到
         _rlStoreLetter → authority → ALLOW → 唯一 canonical writer _rlWriteCanonical
         （roleLetters 只剩一个 dbPut 写点；replyStatus/readAt 状态更新走同一 writer 但不重复裁决）。
         cadence / 对偶冷却（24~72h）/ 已回已拒 / 私有记忆命名空间 roleLetterMemories /
         UI 读信 / 存储形状 / cfg.relationship 全部未改；权威缺席 ⇒ fail closed。
         第二个套件在 vm 沙箱里加载真实 role-letters.js（内存 store + 假 LLM 门控），
         驱动真实 _roleLettersTick。纯 Node、零浏览器、零网络、零真实 provider。 */
      ['test_role_letter_authority.js'],
      ['test_agent_orchestration_role_letter_adapter.js'],
      /* P25-3E · Activity Boundary Audit & Runtime Vocabulary Stress Test（**纯审计阶段**，
         production code changed = 0）：用 Activity / Cinema / Co-read 压测 P25 现有模型
         （Candidate → Authority → Executor → Canonical Writer → Verify）能装下什么、
         什么装不下。结论：单写命令（create/progress/save/delete）装得下；
         session runtime state（current 指针 / 生命周期 / 参与者 / 资源归属）、
         只读观察（frame/progress/subtitle/presence/timeline）与域事件
         （started/finished/joined/left/paused/progressed）**NO_CURRENT_HOME**，
         成为 P26 需求输入（docs/P25-3E-ACTIVITY-BOUNDARY-AUDIT.md、
         docs/P25-3E-RUNTIME-GAPS.md）。
         本套件是静态不变式守卫：清单完整 / 分类闭集与文档一致 / 未注册 activity capability /
         无 Activity Authority / Foundation 逐字节 / Role Letter source 未变 / 无全局 source
         或 decision enum 扩张 / 无 Event Bus / 无 queue / 无 session manager / P23·P24·M1
         Activity runtime 未变 / 无 DB migration。纯 Node、零浏览器、零网络。 */
      ['test_p25_3e_activity_boundary_audit.js'],
      /* P26-0 · Runtime Architecture Requirements Closure（**纯需求闭合阶段**，
         production code changed = 0）：把 P25-3E 找到的缺口（Domain Event Mechanism /
         Generic Observation Layer / Session Runtime Contract / Resource Arbitration +
         条件性 Participant / Runtime Feedback / Source Vocabulary）与 P23/P24/P25 已冻结边界
         收敛成最小、可证明、不过度设计的 P26 Requirements Baseline —— 只给需求，
         不选架构形状、不定 API、不实现 Event Bus / Observer / Session Manager / Arbitration / Feedback。
         产出 docs/P26-0-RUNTIME-REQUIREMENTS.md（MINIMAL_P26 + 候选表 + 硬/条件/未来/不必要分类 +
         非目标 + 候选形状 + 开放问题 + Q1–Q20）与 docs/P26-0-ARCHITECTURE-MAP.md
         （CURRENT ARCHITECTURE / REQUIREMENT MAP / gap matrix / boundary matrix / vocabulary matrix）。
         本套件是静态守卫 R1–R17（生产零改动 / 无 Bus·Observer·SessionManager·ResourceManager·
         queue·scheduler·capability 注册 / 无 source 或 decision enum 扩张 / P23·P24·P25 Foundation·
         四个域权威·Activity runtime 逐字节未变 / DB_VER 与 store 列表未变 / 基线文档齐备）。
         纯 Node、零浏览器、零网络。 */
      ['test_p26_0_runtime_requirements.js'],
      /* P26-1 · Domain Event Contract Foundation（**FOUNDATION / CONTRACT / PURE CORE**）：
         建立 assets/js/domain-event-core.js —— 只回答"什么东西有资格叫 Domain Event"：
         eventId / domain / type / entityId / timestamp（+ 可选 actorId / origin /
         causationId / correlationId），严格闭集字段、深冻结、JSON-serializable、
         禁止业务正文槽与凭据、无时钟（不读 Date.now）、无随机、零 DOM / DB / fetch /
         provider / 权威 / executor / writer / 订阅 / 持久化 / replay / ACK / 唤醒。
         ordering 只给 domain / entity 两个作用域（**禁止**全局序）；
         causationId 裁决 = 字段级 OPTIONAL、可再触发路径由 options.requireCausation 变 REQUIRED。
         本阶段 **Production emitters = 0**：Moments / Diary / Active Message / Role Letter /
         Activity 的生产 canonical writer 零 Domain Event 调用，既有事件式机制
         （Activity on/off/_emit、IBApps.broadcast、Active 事件队列、Mobile Gateway 通知频道）
         与 P23 / P24 / P25 冻结栈逐字节未变，DB_VER 与 store 列表未变。
         套件覆盖 E1–E36 语义与纯度 + G1–G8 生产非接线/冻结守卫。纯 Node、零浏览器、零网络。 */
      ['test_domain_event_core.js'],
      /* P26-2 · Observation Contract Foundation（**FOUNDATION / CONTRACT / PURE CORE /
         AUDIT-FIRST / NO PRODUCTION INTEGRATION**）：建立 assets/js/observation-core.js ——
         只回答"什么是 Observation"：Observation = 某个 source 在某时刻对某 domain/entity
         **当前状态**的可验证描述（"现在是什么"，与 P26-1 的 Event"发生了什么"互为镜像）。
         最小形状：observationId / domain / entityId / source / observedAt /
         freshness(fresh·stale·unknown) / availability(available·unavailable·unknown)
         （+ 可选 valueRef 位置引用）；**禁止** value/snapshot/payload/frameBase64/subtitleText/
         fullActivity 等状态正文槽（大对象走 resource reference）；confidence **不加入**
         （今天没有概率型观察源）。零 DOM / DB / fetch / provider / 权威 / executor / writer /
         订阅 / 路由 / 持久化 / 缓存 / 唤醒；无时钟、无随机、JSON-serializable、深冻结。
         本阶段 **Production observers = 0**：Cinema / Co-read / Voice / Presence / Timeline /
         Memory retrieval / Activity runtime 零接线，既有机制与 P23/P24/P25 冻结栈逐字节未变，
         DB_VER 与 store 列表未变。套件覆盖 O1–O26 语义与纯度 + G1–G9 生产非接线/冻结守卫。
         纯 Node、零浏览器、零网络。 */
      ['test_observation_core.js'],
      /* P26-3 · Session Runtime Contract Foundation（**FOUNDATION / CONTRACT / PURE CORE /
         AUDIT-FIRST / NO PRODUCTION INTEGRATION**）：建立 assets/js/session-core.js ——
         只回答"什么是 Session / 谁拥有 / 生命周期 / 与 Activity·Observation·Event·Resource 的关系"：
         Session = a bounded runtime lifecycle containing participants, state transitions,
         and temporal continuity（不是 Event / Observation / Capability / Canonical Record / Resource）。
         最小 shape：sessionId / domain / participants(canonical id，禁 nickname，集合语义) /
         status / createdAt（+ updatedAt / endedAt）；生命周期闭集 = created → active → ended / failed
         （**paused NOT PRESENT**：P25-3E 已证明活动级 pause 不存在），终态不可再迁移；
         状态迁移表 deterministic、失败返回 result 不抛异常、时间必须注入（不读 Date.now）。
         零 DOM / DB / 传输 / 事件总线 / 观察依赖 / 权威 / executor / 资源仲裁 / 订阅 / 唤醒；
         无随机、JSON-serializable、深冻结。本阶段 **Production sessions = 0**：
         Cinema / Voice / Co-read / Activity / Group Runtime / P23 / Active Message 零接线，
         既有机制与 P23/P24/P25 冻结栈逐字节未变，DB_VER 与 store 列表未变。
         套件覆盖 S1–S19 语义与纯度 + 迁移表/失败语义 + G1–G9 生产非接线/冻结守卫。
         纯 Node、零浏览器、零网络。 */
      ['test_session_core.js'],
      /* P26-4 · Resource Arbitration Boundary Foundation（**FOUNDATION / CONTRACT / PURE CORE /
         AUDIT-FIRST / NO PRODUCTION INTEGRATION**）：建立 assets/js/resource-core.js ——
         只回答"什么是 Resource、谁声明需求、何时竞争、谁仲裁"：
         Resource = a constrained entity whose simultaneous usage requires explicit ownership
         or arbitration（不是 Capability / Session / Observation / Event / Permission）。
         最小形状：resource = { resourceId, domain, capacity (+ 可选 resourceClass) }；
         claim = { claimId, resourceId, requesterId(canonical id), amount?, sessionId? }；
         仲裁结果闭集 = **grant / conflict / deny**（**无** preempt、**无** priority、**无** queue、
         **无** lease/TTL）；holders 由 caller 提供（Core 不持有状态、不持久化）。
         零硬件 / 传输 / DB / scheduler / priority / 抢占 / 会话所有权 / capability 执行 /
         观察依赖 / 事件总线；无时钟、无随机、JSON-serializable、深冻结。
         本阶段 **Production resources = 0**：Cinema / Voice / Camera / Microphone / GPU /
         Model Router / Mobile 零接线，既有机制与 P23/P24/P25/P26-1·2·3 冻结栈逐字节未变，
         DB_VER 与 store 列表未变。套件覆盖 R1–R16 语义与纯度 + G1–G9 生产非接线/冻结守卫。
         纯 Node、零浏览器、零网络。 */
      ['test_resource_core.js'],
      /* P26-5 · Feedback Boundary Foundation（**FOUNDATION / CONTRACT / PURE CORE /
         AUDIT-FIRST / NO PRODUCTION INTEGRATION**）：建立 assets/js/feedback-core.js ——
         只回答"什么是 Feedback、什么信息可以进入它、与 Event/Observation/Agent Wake/Autonomy
         的边界"：Feedback = a derived signal that evaluates whether existing facts or
         observations require further attention（不是 Event / Observation / Action / Command /
         Decision）。最小形状：feedbackId / domain / source / reason（**机器可读原因码**，非自由文本）/
         timestamp（+ 可选 severity ∈ low·medium·high / relatedEntity / derivedFrom）。
         severity 属反馈本身；**priority / urgency / rank / schedule 属 policy**，契约显式
         `policy-only-field` 拒绝。禁止 full payload / canonical body / memory dump。
         Feedback 不执行 capability、不调 Authority、不创建 Action、不唤醒 Agent
         （Feedback Available ≠ Agent Wake；无 triggerAgent）；零 Event Bus / Router / Scheduler /
         Policy Engine / 持久化 / store / queue；无时钟、无随机、JSON-serializable、深冻结。
         本阶段 **Production feedback = 0**：Cinema / Voice / Activity / Active Message /
         Role Letter / Autonomy Core / Orchestration 零接线，既有机制与 P23/P24/P25 及
         P26-1..4 冻结栈逐字节未变，DB_VER 与 store 列表未变。
         套件覆盖 F1–F16 语义与纯度 + G1–G9 生产非接线/冻结守卫。纯 Node、零浏览器、零网络。 */
       ['test_feedback_core.js'],
       /* P26-6 · Feedback Consumption & Wake Eligibility Contract（**FOUNDATION / CONTRACT /
          PURE CORE / AUDIT-FIRST / NO PRODUCTION INTEGRATION**）：建立
          assets/js/feedback-consumption-core.js —— 只回答"一条 Feedback 被消费后，系统可以得出
          什么注意力处理结论？"。Feedback Consumption = a pure evaluation of a Feedback signal
          against explicit context to determine its attention disposition（不是 handling side effect /
          execution / notification / model call）。处置闭集只有三个：IGNORE（无需进一步 runtime
          attention）/ OBSERVE（有意义上报状态/telemetry/UI/未来上下文）/ WAKE_ELIGIBLE（**有资格**
          进入未来 wake request policy，**不是** Wake）。原因码闭集：wake-eligible / default-observe /
          duplicate / cooldown / cancelled / invalid-feedback / invalid-context。
          context 是**闭集布尔字段**：wakeCapable / cancelled / alreadyConsumed / recentEquivalent /
          cooldownActive（cancelled·dedupe·cooldown 均由 caller 注入；Core 不持时钟、不持 dedupe store）；
          FORBIDDEN_CONTEXT_FIELDS 显式拒绝 metadata / payload / priority / urgency / rank / retry /
          runtimeAvailable / userPresent / sessionActive / attention / score / energy / budget 及一切
          凭据类字段（apikey/token/secret/credential/authorization…），context 不得成为凭据逃生舱。
          **severity / priority 完全不参与判定**：high severity ≠ automatic WAKE_ELIGIBLE（由显式
          consumption policy 决定）；未引入 DEFER（"以后可能 wake"属未来 scheduler / cooldown /
          wake runtime，非本契约）；eligibility ≠ deliverability（runtime unavailable 不改变资格）。
          Wake Ladder 只到 WAKE_ELIGIBLE：Feedback Exists → Consumption → WAKE_ELIGIBLE →
          [future Wake Request] → [future Runtime Wake] → [future Planner] → Action → P25 Autonomy →
          Domain Authority → Executor。不调 P25 Autonomy、不选 Capability、不调模型、不订阅 Event、
          不读 Observation、不改 Session、不做 Resource arbitration、不通知、不持久化 / 无 store /
          无 queue / 无 scheduler / 无 router / 无 Event Bus；无时钟、无随机、JSON-serializable、
          深冻结、Feedback 只读不改。本阶段 **Production consumers = 0 · Production wakes = 0**：
          Active Message / Diary / Role Letter / Moments / Activity / Cinema / Voice / P24 /
          Middle Brain / Agent Runtime 零接线，既有机制与 P23/P24/P25 及 P26-1..5 冻结栈逐字节未变，
          DB_VER 与 store 列表未变。套件覆盖 C1–C34 语义与纯度 + LM1·LM2 循环守卫 + G1–G3
          生产非接线/冻结守卫。纯 Node、零浏览器、零网络。 */
       ['test_feedback_consumption_core.js'],
       /* P26-7 · Wake Request Boundary Foundation（**FOUNDATION / CONTRACT / PURE CORE /
          AUDIT-FIRST / NO PRODUCTION INTEGRATION**）：建立 assets/js/wake-request-core.js ——
          只回答"一个已经 eligibility 的信号如何表达'请未来 runtime 考虑一次激活'"。
          Wake Request = a request object representing that a previously eligible signal
          asks a future runtime to consider activation（不是 Wake / Agent execution /
          Action / Capability call / Permission）。边界阶梯只到 Wake Request：
          Feedback Exists → Consumption → WAKE_ELIGIBLE → **Wake Request** → STOP
          （之后 Wake Runtime → Planner → Action → P25 Autonomy 全为未来阶段）。
          唯一合法生产者是 Feedback Consumption：createWakeRequest 只能从
          disposition = WAKE_ELIGIBLE 的 P26-6 消费结果创建（OBSERVE/IGNORE ⇒ not-eligible；
          裸 feedback ⇒ not-eligible，不得绕过 Consumption；feedback 与 consumption 身份
          不一致 ⇒ feedback-mismatch）。最小身份（闭集）：wakeRequestId（确定性 'wr_<token>'，
          注入优先）/ feedbackId / domain / source / reason / createdFrom（默认 'consumption'）
          + 可选 derivedFrom / causationId + 固定 version 'wake-request/v1'。处置词汇**来自**
          P26-6（同一引用，不复制第二份）；feedback 校验**委托** P26-5。
          禁止：priority/urgency/rank/deadline（policy-only-field）；queue/pendingRequests/waitingList；
          timer/retry/backoff/expiration；WakeRequestStore/去重集合（caller 提供 alreadyRequested）；
          持久化 / 数据库 / localStorage；Event Bus（publish/subscribe/emit/consume）；
          运行时激活 / 模型 / planner / autonomy / authority / executor；无时钟、无随机、
          JSON-serializable、深冻结。本阶段 **Production wake request = 0**：Active Message /
          Diary / Role Letter / Activity / Cinema / Voice / Middle Brain / P24 零接线，
          既有机制与 P23/P24/P25 及 P26-1..6 冻结栈逐字节未变，DB_VER 与 store 列表未变。
          套件覆盖 W1–W23 语义与纯度 + G1–G3 生产非接线/冻结守卫。纯 Node、零浏览器、零网络。 */
       ['test_wake_request_core.js'],
       /* P26-8 · Wake Runtime Boundary Foundation（**FOUNDATION / CONTRACT / PURE CORE /
          AUDIT-FIRST / NO PRODUCTION INTEGRATION**）：建立 assets/js/wake-runtime-core.js ——
          只回答"一条 Wake Request 被谁消费、什么时候可以考虑 activation"。
          Wake Runtime = a runtime boundary that evaluates whether a Wake Request may proceed
          toward activation（不是 Agent Runtime / Planner / Executor / Authority / Scheduler）。
          边界阶梯只到 Wake Runtime 的 activation 判定：
          Feedback → Consumption → WAKE_ELIGIBLE → Wake Request → **Wake Runtime** → STOP
          （之后 Activation → Planner → Action → P25 Autonomy 全为未来阶段）。
          Activation 闭集：ACTIVATE_ELIGIBLE / BLOCKED / REJECTED（**不用** ALLOW/DENY/EXECUTE，
          与 P25 决策词汇不重叠）。context 为**闭集布尔字段**且**显式注入**：
          runtimeAvailable / cancelled / alreadyActive；缺字段 fail closed；
          FORBIDDEN_CONTEXT_FIELDS 显式拒绝 metadata/payload/provider/model/prompt/memory dump/
          apiKey/token/credential/authorization 及一切凭据类字段。判定顺序（deterministic）：
          invalid-request → invalid-context → cancelled(REJECTED) → already-active(BLOCKED) →
          runtime-unavailable(BLOCKED) → activate-eligible。请求校验**委托** P26-7
          （唯一实现，不复制第二份）；identity 审计结论**不引入 activationId**（判定非实体，
          无 random UUID）；causation 保留 feedbackId / wakeRequestId / causationId。
          禁止：start agent / call model / create action / call authority / execute capability；
          queue / pending wake / retry queue；timer / cron / retry / backoff；
          persistence / store / activation history；Event Bus（publish/subscribe/consume）；
          Session 创建（session 只作 context 事实，sessionActive 被拒）；Resource 仲裁
          （resourceAvailable 被拒）；无时钟、无随机、JSON-serializable、深冻结。
          本阶段 **Production wake runtime = 0**：Agent Runtime / Active Message / Diary /
          Role Letter / Activity / Cinema / Voice / Middle Brain / P24 零接线，既有机制与
          P23/P24/P25 及 P26-1..7 冻结栈逐字节未变，DB_VER 与 store 列表未变。
          套件覆盖 W1–W23 语义与纯度 + G1–G3 生产非接线/冻结守卫。纯 Node、零浏览器、零网络。 */
       ['test_wake_runtime_core.js'],
       /* P26-9 · Activation Intent Boundary Foundation（**FOUNDATION / CONTRACT / PURE CORE /
          AUDIT-FIRST / NO PRODUCTION INTEGRATION**）：建立 assets/js/activation-intent-core.js ——
          只回答"一条 ACTIVATE_ELIGIBLE 结果如何形成未来 activation 请求的意图"。
          Activation Intent = a pure intent object indicating that a runtime activation may be
          requested in the future（不是 Agent Wake / Agent Start / Planner Call / Action / Capability）。
          边界阶梯只到 Activation Intent：
          Feedback → Consumption → WAKE_ELIGIBLE → Wake Request → Wake Runtime →
          ACTIVATE_ELIGIBLE → **Activation Intent** → STOP
          （之后 Agent Runtime → Planner → Action → P25 Autonomy 全为未来阶段）。
          唯一合法来源是 Wake Runtime 的 ACTIVATE_ELIGIBLE 判定：createActivationIntent 只能从
          ok:true 且 activation:ACTIVATE_ELIGIBLE 的 P26-8 结果创建（BLOCKED/REJECTED/ok:false ⇒
          not-activatable；裸 Wake Request 当第一参数 ⇒ invalid-wake-result，不得绕过）；
          request.wakeRequestId 必须与结果一致（否则 request-mismatch）。identity 审计结论
          **需要 activationIntentId**（意图是新对象）：确定性 'ai_<token>'，注入优先，无 random UUID。
          causation 保留 feedbackId / wakeRequestId / causationId（options 优先否则随请求携带）/
          derivedFrom；**无 state**（created/consumed/expired 属未来队列生命周期）。
          请求校验**委托** P26-7；激活词汇表**来自** P26-8（同一引用，不复制第二份）。
          禁止：start agent / call model / call planner / call autonomy / call authority；
          intent queue；timer/retry/backoff；intent store / activation history；Event Bus；
          ActivationManager / ActivationService；无时钟、无随机、JSON-serializable、深冻结、
          RESERVED/POLICY-ONLY 字段显式拒绝（metadata/payload/priority/urgency/retry…）。
          本阶段 **Production activation intent = 0**：Agent Runtime / Active Message / Diary /
          Role Letter / Activity / Cinema / Voice / Middle Brain / P24 零接线，既有机制与
          P23/P24/P25 及 P26-1..8 冻结栈逐字节未变，DB_VER 与 store 列表未变。
          套件覆盖 A1–A20 语义与纯度 + G1–G3 生产非接线/冻结守卫。纯 Node、零浏览器、零网络。 */
       ['test_activation_intent_core.js'],
       /* P26-10 · Activation Runtime Boundary Foundation（**FOUNDATION / CONTRACT / PURE CORE /
          AUDIT-FIRST / NO PRODUCTION INTEGRATION**）：建立 assets/js/activation-runtime-core.js ——
          只回答"一条 Activation Intent 如何进入未来 agent activation pipeline"。
          Activation Runtime = a runtime boundary that accepts Activation Intent and evaluates
          whether it may enter an agent activation pipeline（不是 Agent Runtime / Planner /
          Executor / Authority）。边界阶梯只到 Activation Runtime 的 readiness 判定：
          Feedback → Consumption → Wake Request → Wake Runtime → Activation Intent →
          **Activation Runtime** → STOP（之后 Agent Runtime → Planner → Action → P25 全为未来阶段）。
          readiness 闭集：READY / BLOCKED / REJECTED（**不用** ALLOW/DENY/EXECUTE，与 P25 决策
          词汇不重叠）。context 为**闭集布尔字段**且**显式注入**：runtimeAvailable /
          targetAvailable / cancelled；缺字段 fail closed；FORBIDDEN_CONTEXT_FIELDS 显式拒绝
          model/provider/prompt/memory dump/apiKey 及一切凭据类字段。判定顺序（deterministic）：
          invalid-intent → invalid-context → cancelled(REJECTED) → target-unavailable(BLOCKED) →
          runtime-unavailable(BLOCKED) → ready。identity 审计结论**不引入 activationRequestId**
          （结果是对已有 Intent 的判定，复用 activationIntentId；无 random UUID）；causation 保留
          activationIntentId / wakeRequestId / feedbackId / causationId。Intent 校验**委托** P26-9。
          禁止：createAgent / wakeAgent / runAgent；call model / create action / call planner /
          call authority；queue；timer/retry/backoff；store/history；Event Bus；
          ActivationManager / AgentStarter / WakeService；无时钟、无随机、JSON-serializable、深冻结。
          本阶段 **Production activation runtime = 0**：Agent Runtime / Active Message / Diary /
          Role Letter / Activity / Cinema / Voice / Middle Brain / P24 零接线，既有机制与
          P23/P24/P25 及 P26-1..9 冻结栈逐字节未变，DB_VER 与 store 列表未变。
          套件覆盖 B1–B21 语义与纯度 + G1–G3 生产非接线/冻结守卫。纯 Node、零浏览器、零网络。 */
       ['test_activation_runtime_core.js'],
       /* P26-C · Runtime Architecture Closure Guard（**CLOSURE / ARCHITECTURE AUDIT /
          READ-ONLY / NO NEW FOUNDATION LAYER / NO PRODUCTION INTEGRATION**）：
          保护 P26-1..10 十个 pure core 的冻结状态与"生产零接线"事实，并断言：
          C1 十个 foundation 文件存在；C2 逐字节哈希冻结（含 P26-7..10）；
          C3 生产 HTML 不加载任何 P26 core；C4 DB_VER=24 且无任何 P26 概念 store；
          C5 每层闭集 API（冻结的导出函数集合）；C6 依赖 DAG 正确（P26-6→5 / 7→{5,6} /
          8→7 / 9→{7,8} / 10→9；P26-1..4 互相独立；foundation 层不得依赖 P23/P24/P25 生产模块）；
          C7 生产消费者 = 0；C8 P26-0 基线与 P26-CLOSURE 文档存在。
          审计结论（见 docs/P26-CLOSURE.md）：P26 CLOSURE: PASS WITH NOTES / P26 LOGICALLY FROZEN；
          P26-1..4 = ESSENTIAL（对应 P26-0 HARD）；P26-5..8 = JUSTIFIED_BUT_FUTURE；
          P26-9/P26-10 = REDUNDANT_CANDIDATE（只审计、不删除）；EVENT BUS NOT REQUIRED YET；
          Agent Runtime Entry verdict = STOP_FOUNDATION（不新增 P26-11）。纯 Node、零浏览器、零网络。 */
       ['test_p26_closure_guard.js'],
       /* P27-0 · Activity Production Wiring Guard（**READ-ONLY evidence guard**）：
          把 P27-0 审计到的 Activity 生产事实固定下来，使后续 P27-x 一旦漂移立即变红：
          A1 canonical storage（`activities` store + `ib_activity_current_v1` 指针 + DB_VER=24，
          且无第二个 Activity canonical store）；A2 唯一 canonical writer = activity-runtime.js
          （Cinema/Co-read/communication/app-store 一律经 IB.activity.*）；A3 API surface 冻结
          且 finish/pause/resume **NOT PRESENT**；A4 `status:'finished'` 只有读侧、生产零 writer；
          A5 `activity.mark` 无生产调用者；A6 `createActivity` 只被 Cinema + Co-read 调用；
          A7 Chat 仍拥有 chatMessages canonical authority（activity.send 委托 sendChatMessage）；
          A8 Activity/Cinema/Co-read/communication **零引用 P26-5..10**；A9 HTML 静态加载
          activity-runtime.js + coread.js，Cinema 经 apps/catalog 惰性加载；A10 未引入 Event Bus。
          本守卫不修改任何生产代码。纯 Node、零浏览器、零网络。 */
       ['test_p27_0_activity_wiring_guard.js'],
       /* P27-1 · Activity Lifecycle Closure Guard（**PRODUCTION INTEGRATION / LIFECYCLE
          SEMANTICS ONLY / MINIMAL CHANGE / NO NEW WRITER / NO SCHEMA MIGRATION**）：
          L1 `finishActivity` 存在并经既有 writer 暴露；L2 pause/resume 仍 NOT PRESENT
          （Cinema pause 只属 media transport）；L3 finish 不自己写库（只经 saveActivity，
          只改已有 status，无 finishedAt）；L4 **vm 语义探针**真实执行 finishActivity
          （create→setCurrent→finish 置 finished + 清指针；第二次幂等零写；setCurrent 返回 null；
          send 返回 activity_finished；nudge 返回 false）；L5 canonical writer 仍唯一
          （只有 activity-runtime.js 写 activities）；L6 pointer 不是 authority / 不是 session
          （无 sessionId / 无 session-core / 无 start-end-transition）；L7 无迁移（DB_VER=24、
          无新 store、无新字段）；L8 Cinema close 仍 clearCurrent（未转 finish）；
          L9 Co-read leave 仍 clearCurrent、progress/bookmark 语义不变；
          L10 零 P26-5..10 引用、无 Event Bus。纯 Node、零浏览器、零网络。 */
       ['test_p27_1_activity_lifecycle_guard.js'],
       /* P27-2 · Activity Created Domain Event Guard（**PRODUCTION INTEGRATION / MINIMAL EVENT
          WIRING / ONE EVENT ONLY / NO EVENT BUS / NO MANAGER / NO MIGRATION**）：
          唯一接线 —— createActivity 的 canonical 写入（dbPut('activities')）成功之后，
          经 P26-1 createDomainEvent 产生 `activity.created`（domain='activity', type='created',
          entityId=activityId, actorId=roleId, origin='runtime', timestamp=createdAt）。
          边界证据（vm + 桩真实执行）：E1 成功创建恰好一个事件；E2 事件携带 activityId；
          E3 事件**不含** Activity 正文/聊天历史/记忆/帧/字幕/凭证且小于记录本身；
          E4 canonical writer 失败 ⇒ null 且零事件；E5 事件失败（抛错 / ok:false / 核心缺失）
          ⇒ Activity **仍创建**（不回滚）；E6 无 Event Bus / Manager / event store，DB_VER=24；
          E7 接缝在 canonical 写入之后、恰一个调用点、不复制 P26-1 契约、**仅此一个事件**、
          生产 HTML 只加载这一个 P26 core。生产改动仅两处：activity-runtime.js 的 helper+调用，
          以及 InternalBeyond.html 新增 domain-event-core.js（放在 chat-core / voice-message-core 之后）。
          本次同时**有意重新基线** P26-1 / P26-closure / P26-0 / P25-3E / P26-2..5 中冻结的
          activity-runtime 哈希与 emitter / HTML 断言。纯 Node、零浏览器、零网络。 */
       ['test_p27_2_activity_created_event_guard.js'],
       /* P27-3 · Activity Observation Guard（**PRODUCTION INTEGRATION / MINIMAL OBSERVATION
          WIRING / DOMAIN-OWNED GETTERS / NO OBSERVATION MANAGER / NO REGISTRY / NO MIGRATION**）：
          唯一接线 —— IB.activity.getObservation(activityId, {observedAt?}) 对 canonical Activity
          状态做**只读**观察（domain='activity', source='activity.state', entityId=activityId,
          valueRef='activities/<activityId>'），经 P26-2 createObservation 创建（不复制契约）。
          边界证据（vm + 桩真实执行，真 event core + 真 observation core）：O1 观察合法；
          O2 entityId 指向正确 Activity；O3 不复制完整 Activity 对象；O4 无 subtitle/frame/page/
          chat 正文泄漏；O5 **观察读取 0 写入**；O6 不可用来源不改变状态且非法 id 返回 null；
          O7 观察**不发** Domain Event；O8 无 Feedback/Wake/Agent 行为；O9 无 manager/registry/
          store/queue/scheduler 且只有一个观察入口；O10 DB_VER 仍 24 且无 observation store；
          O11 生产只加载 domain-event-core + observation-core 两个 P26 core；O12 P27-2
          activity.created 行为保持；O13 核心缺失安全（null + 0 写入）。
          候选 current / subtitle / frame / page / progress 全部 **DEFER**（见 docs 报告 §2）。
          production 改动仅两处：activity-runtime.js 新增只读 getter，InternalBeyond.html
          新增 observation-core.js（紧随 domain-event-core.js）。冻结基线更新分类：
          observation-core 守卫/O26-closure/P27-2 为**语义**更新（A），其余为**整文件哈希**更新（B）
          —— 记录 HASH_COUPLING_DEBT 交 P27-C。纯 Node、零浏览器、零网络。 */
       ['test_p27_3_activity_observation_guard.js'],
       /* P27-4 · Activity Session Projection Guard（**PRODUCTION INTEGRATION / READ-ONLY
          SESSION PROJECTION / MINIMAL WIRING / NO SESSION STORE / NO SESSION MANAGER /
          NO MIGRATION**）：唯一接线 —— IB.activity.getSession(activityId) 把 canonical
          Activity 记录**只读投影**成 P26-3 Session（复用 createSession 构造器 + validateSession
          校验；**不**调用 transitionSession；**不**调用带写副作用的 resolveActivity）。
          sessionId = activityId（复用，不新增持久身份）；participants = [roleId]（role-only，
          **不发明** user/self/me）；status: active→active、finished→ended；createdAt ← rec.createdAt；
          updatedAt ← rec.updatedAt；**无 endedAt**（Activity 无 finishedAt，P26-3 中 endedAt 可选）。
          **不需要 current 指针**（记录独立充分）。边界证据（vm + 桩真实执行）：S1 合法 Session；
          S2 sessionId 映射且不新增持久字段；S3 role-only 参与者；S4 active 映射；S5 finished→ended
          且不发明 endedAt；S6 缺失→null；S7 投影零写入；S8 指针缺失≠Session 结束；S9 陈旧指针无清理写；
          S12 不发事件；S13 不产生 Observation；S14 无 Feedback/Wake/Agent；S15/S15b 无 Manager/
          Store/Registry 且函数体不调用 resolveActivity、不写存储；S16 DB_VER 24；S17 只加载 3 个预期
          P26 core；S18/S19 P27-2/P27-3 保持；S20 核心缺失安全；S21 未知状态 fail closed。
          production 改动仅两处：activity-runtime.js 新增只读投影 getter，InternalBeyond.html
          新增 session-core.js。冻结基线更新：session/observation/closures/P27-1/P27-2/P27-3 为
          **语义**（A），其余为**整文件哈希**（B）—— 第 3 次 B 类重复 ⇒
          HASH_COUPLING_DEBT = CONFIRMED STRUCTURAL TEST DEBT（交 P27-C）。纯 Node、零浏览器、零网络。 */
       ['test_p27_4_activity_session_projection_guard.js'],
       /* P27-C · Activity Production Integration Closure Guard（**CLOSURE / PRODUCTION-INTEGRATION
          AUDIT / TEST-ARCHITECTURE CLEANUP / NO NEW DOMAIN FEATURE / NO NEW P26 WIRING /
          NO RESOURCE INTEGRATION / NO EVENT BUS**）：断言 P27 高层冻结架构 C1–C12 ——
          C1 canonical Activity authority 唯一（`core.js` 仅既有备份导入路径）；
          C2 唯一生产 Activity Domain Event = activity.created（下游于 canonical 写入）；
          C3 唯一生产 Activity Observation = activity.state（只读、引用式）；
          C4 getSession 只读投影（函数体内无 dbPut/dbDelete/localStorage/resolveActivity/
          transitionSession/createDomainEvent/createObservation）；C5 P27-5 Resource 未集成；
          C6 P26-5..10 未接线；C7 DB_VER=24 且零新 store；C8 无 Event Bus/Manager/Store；
          C9 生产只加载 domain-event + observation + session 三个 P26 core；
          C10 Cinema/Co-read 所有权保持（哈希 + 无 finish/endSession）；C11 P23/P24/P25 边界；
          **C12 HASH_COUPLING_DEBT 结构性修复**：7 个既有守卫不再依赖 activity-runtime 整文件
          哈希，改用 tests/activity-partitions.js 的**语义分区**断言；并在**字符串副本**上做
          变异测试证明"canonical writer / pointer 语义变化必被发现"，而"新增无关 getter /
          改 P27 适配器不触发既有分区重签"。本阶段**零 production 变更**。纯 Node、零网络。 */
       ['test_p27_closure_guard.js'],
       /* P28-0 · Runtime Entry Guard（**READ-ONLY ARCHITECTURE AUDIT / EVIDENCE-FIRST /
          NO PRODUCTION MUTATION / NO NEW FOUNDATION / NO NEW MANAGER / NO EVENT BUS**）：
          冻结 P28-0 审计到的运行时事实 —— R1 `assets/js/agent-runtime.js` 是**真实存在且被 HTML
          加载**的 ModelPort 运行时（`IB.runtime.instance` + resolveModel + execute；retry/round/FC
          明确留在既有执行器）；R2 它被 **Active Message / Diary / Moments** 三个生产域**真实调用**
          （`runtime.execute(` + 可回滚开关 runtimeExecuteEnabled / runtimeMomentsExecuteEnabled）；
          R3 **P25-3A 未接线**（orchestration core / capability registry 不在 HTML，且生产零调用
          runAgentPlan/validateAgentPlan/createCapabilityRegistry）；R4 `active_agent_runtime` 是
          **Economy consumer 身份**（锚点 `runtime/component-registry.js#active`；装配只绑它；
          其它 consumer id 零绑定；不存在同名模块）；R5 P27 三项输出（activity.created /
          activity.state / getSession）生产**消费者仍为 0**；R6 Group Runtime（P24）由
          communication.js 生产调用；R7 tool loop 归 chat 执行器（autoContinue + maxRounds）；
          R8 Middle Brain 边界（生成后收口，不进入 model seam）；R9 DB_VER=24 且无 runtime 类
          store；R10 无新增 Bus/Manager。本阶段**零 production 变更**。纯 Node、零浏览器、零网络。 */
       ['test_p28_0_runtime_entry_guard.js'],
       /* P28-1 · Runtime Boundary Freeze Guard（**ARCHITECTURE DECISION CLOSURE / BOUNDARY
          FREEZE / NO PRODUCTION IMPLEMENTATION / NO NEW RUNTIME / NO CONVERGENCE /
          NO EVENT BUS / NO SCHEMA CHANGE**）：把 P28 的运行时边界冻结为**语义不变量**
          （F1–F15，**不用整文件哈希**）——
          F1 `IB.runtime` 仍是生产加载的共享模型执行缝且被 Active Message / Diary / Moments 消费；
          F2 P25-3A 未被生产加载；F3 无生产 runAgentPlan 调用者；F4 `active_agent_runtime` 仍是
          Economy consumer 身份（锚点 runtime/component-registry.js#active，非模块）；F5 P27 输出
          消费者状态冻结（0 / 既有更丰富路径 getActivityContext 仍在）；F6 P26-5..10 未接线；
          F7 P26-9/10 非生产；F8 无 AgentRuntimeManager/ConsumerManager/Event Bus；
          F9 无 runtime/session/wake store；F10 DB_VER=24；F11 P23 交付所有权完好；
          F12 P24 群参与所有权完好；F13 域权威/域 writer 仍属域（IB.runtime 零写库零裁决）；
          F14 IB.runtime 保持窄（无 timer / 无 chatMessages / 无 queue/typing / retry 留在执行器）；
          F15 不存在统一 runtime 生产入口。本阶段**零 production 变更**。纯 Node、零网络。 */
       ['test_p28_1_runtime_boundary_freeze.js'],
      /* P24-M1 · Group Turn Identity Foundation —— 群聊 identity-only 地基：
         groupTurnId（由触发本回合的 canonical user message id 确定性派生）/
         MemberTurn turnId（与 P23 turnIdFor 逐字等值）/ speakerId（apiConfigs.id）/
         groupOrder（成员回合序号，不替代 sequenceIndex）。覆盖确定性、跨模块等值、
         多单元同回合、多成员独立、legacy 兼容、单聊隔离、Home Node payload 往返、
         秘密拒绝、不产生 parent/groupTurn 行、以及"绝不复制 P23 的排序·队列·拆句·
         模态·voice 契约"的边界断言。纯 Node，零浏览器、零网络、零真实 provider。 */
      ['test_group_turn_identity.js']
    ]
  },
  {
    name: 'p22-ui',
    note: 'P22-15/16/17/18 · Economy 的四个用户面（Approval / Configuration / Store·Wallet·Inventory / Experience 解释层）——纯层 + 渲染器；浏览器视觉核对不在默认套件里',
    tests: [
      /* P22-15 第一次让这一域出现**浏览器侧**的文件：
           assets/js/economy-approval-core.js（纯层：视图模型 / 文案映射 /
           请求体构造）与 assets/js/economy-approval.js（渲染器）、
           assets/css/economy-approval.css（运行时注入，不占 HTML 的样式表预算）。
         ui_core —— 纯层加载进一个**没有 document、没有 fetch、没有 location**
                    的沙箱：于是"它不碰 DOM、不发请求"是环境事实而不是注释；
                    同时逐字比对币种 scale / 展示名 / 商品类别三张镜像表与
                    canonical 契约一致，以及 §14 的文案表覆盖全部 50 个
                    DENY_REASON、§15 的请求体恰好三个字段（函数签名只有三个
                    位置参数，没有第四个位置可以放身份或金额）。
         ui      —— 一个只实现渲染器真正用到的成员的 DOM 桩 + 真实网络形状的
                    假 driver：渲染 / APPROVE 与 REJECT 的请求体 / 双击保护 /
                    拒绝的两步确认 / 决定之后**重新读** canonical 状态（不乐观
                    宣称购买成功）/ APPROVED 而最终 DENY / 完成 / 拒绝 / 过期 /
                    失败 / 空状态 / 坏读模型 / 节点不可达 / 凭据未配置。
                    ★ 零子进程、零 socket、零浏览器。
         visual  —— ★ 这个**不在**默认套件里（它要开一个真实浏览器，与
                    test_ui_regression.js 同款）。它存在的唯一理由是 §12/§13/
                    §18 的三条人工要求："internal / infernal / desktop / narrow /
                    mobile 都真的看一眼"。跑法：
                      node tests/test_p22_15_economy_approval_visual.js
                    它按 2 主题 × 3 宽度各截一张图到 %TEMP%（**不写进仓库**），
                    并在真实排版引擎上断言卡片宽度 / 横向溢出 / 按钮尺寸 /
                    主题令牌真的换了 / 浅色主题那条白色发光在卡片子树里被关掉。
                    P22-15 交付时它 66/66 通过，六张图人工看过。 */
      ['test_p22_15_economy_approval_ui_core.js'],
      ['test_p22_15_economy_approval_ui.js'],
      /* P22-16 · Economy Configuration UI（钱包与初始额度 / 预算限制 / 自主购买）。
         ui_core —— 纯层加载进一个**没有 document、没有 fetch、没有 location**
                     的沙箱：于是"它不碰 DOM、不发请求"是环境事实而不是注释；
                     同时逐字比对镜像表与 canonical 契约/配置 seam 一致
                     （命令词表 / 信封键 / 每命令 config 白名单 / 币种 scale /
                     limits 键 / 自主等级 / 商品类别 / 交付方式），并证明
                     "留空 = 不设""空选集 = 省略""非法输入 = 一个请求都不发"
                     这些投影规则是结构性的。
         ui      —— 一个只实现渲染器真正用到的成员的 DOM 桩 + 真实网络形状的
                     假 driver：fresh / 已初始化两种钱包状态 / 预算与自主的
                     canonical 投影逐字节比对 / 非法输入 fail closed / 保存后
                     重新读权威 / 配置面关着时不提供假按钮 / 页签开合不搬动
                     P22-15 的 DOM 节点。
                     ★ 零子进程、零 socket、零浏览器。
                     ★ 角色目录的桩与**生产同形**：裸标识符与 window 的活
                       getter 两条都装（social.js:607 / 2654），因为只装一条
                       的桩看不见"渲染器只认某一条路"这种缺陷。
         visual  —— ★ 这个**不在**默认套件里（它要开一个真实浏览器）。跑法：
                       node tests/test_p22_16_economy_configuration_visual.js
                     它按 2 主题 × 3 宽度各截一张图到 %TEMP%（**不写进仓库**），
                     并在真实排版引擎上断言外壳宽度 / 横向溢出 / 刻度条真的按
                     权威数据算出百分比 / 主题令牌真的换了 / 按钮在手机上是整行
                     的，以及**没有任何覆盖视口的层把页面糊掉**（这是开发期真的
                     发生过的事：截图是一团雾而所有 DOM 断言全绿）。
                     P22-16 交付时它 86/86 通过，十六张图人工看过。 */
      ['test_p22_16_economy_configuration_ui_core.js'],
      ['test_p22_16_economy_configuration_ui.js'],
      /* P22-17 · Economy Store / Wallet / Inventory UI（概览 / 商店 / 我的资产）。
         ★ 它是 Economy 页面的**外壳**：五个外层页签，其中「待处理」与
           「设置」分别委托给 P22-15 / P22-16 各自的渲染器（本阶段不复制
           任何一边的实现，只开合它们的可见性）。
         ui_core —— 纯层加载进一个**没有 document、没有 fetch、没有 location**
                      的沙箱，而且**先**加载 P22-16 的纯层（币种 scale /
                      展示名 / 商品类别 / 角色目录四张镜像表只有一个出处）。
                      它钉住的是"从五条只读面读回来的 JSON 长成什么样子"：
                      钱包三态（COLD / DEGRADED 的主数字是 null，不是 0）、
                      预算摘要不含 decision、目录顺序就是读面顺序、
                      assetKind 分组、购买状态的人话映射、
                      以及**确定性视觉身份的签名只有一个位置参数**
                      （于是 buyerId / 关系 / 亲和度在结构上进不来）。
         ui      —— 一个只实现渲染器真正用到的成员的 DOM 桩 + 真实网络形状的
                      假 driver：五个页签 / 默认概览 / 委托两格的开合 /
                      外壳追加在页尾（P22-15/16 的两个节点位置逐字未变）/
                      钱包与预算与购买与资产的渲染 / 商品卡上没有购买按钮 /
                      八个读路径全在既有白名单里 / 两个写方法一次都没被调用 /
                      正文里没有 canonical 原始代号（只在折叠的技术层）。
                      ★ 零子进程、零 socket、零浏览器。 */
      ['test_p22_17_economy_store_ui_core.js'],
      ['test_p22_17_economy_store_ui.js'],
      /* ── P22-18 · Economy Experience（解释层）──────────────────────────
         core —— 「解释层不产生任何经济事实」这一条纪律的纯层部分：
                  canonical change log 的**每一个**事件类型都有一句人话
                  （名单从契约与 store 的源码里抽出来，不是本地编的）/
                  归属只用 canonical 自己的键、收礼者不算 /
                  时间线按 canonical 的 revision 倒序、截断时说出来 /
                  §3 的"来源"与"三步"各有证据 /
                  §4 的理由**逐字**（不摘要、不改写、不再调模型）/
                  §7 的高级信息只有四个编号、默认折叠。
         ui   —— 同一条纪律的渲染器部分：概览的四个区域共用同一份归属 /
                  时间线四态（有数据 / 空 / 读不到 / 被截断）/
                  change log 按 owner 作用域、**从最新往前**地读（P22-19 起）/
                  高级信息默认折叠、点一下展开 /
                  九个读路径全在声明里 / 两个写方法一次都没被调用 /
                  三个既有节点的 DOM 顺序逐字未变。
                  ★ 零子进程、零 socket、零浏览器。 */
      ['test_p22_18_economy_experience_ui_core.js'],
      ['test_p22_18_economy_experience_ui.js'],
      /* ── P22-19 · Economy Read Model & Owner Scope Closure ─────────────
         ★ 这一阶段**没有**新增 Economy 功能：它把"一条 change 属于谁"
           从浏览器解释层收回到 canonical 的只读 query 里，并把只读契约
           冻结成机器可检查的东西。

         读契约 —— 四个 UI（P22-15/16/17/18）的
                   READS / WRITES / OPTIONAL_READS /
                   AUTHORITY_FIELDS / DERIVED_FIELDS 声明
                   × 各个 core 的**真实导出**逐字比对；
                   归属只有一处实现（纯层里不存在第二份）；
                   §7 完整性三态各自有自己的话；
                   §10 高级信息仍然只是调试面；
                   §14 本阶段禁止的一整套词一个都没有出现；
                   schema 水位仍然是 7（本阶段没有写入侧改动）。
         owner scope —— **真实 store**：两个 owner 的隔离 / 全部 §12 场景
                   （gift 双向 / AUTO_ALLOW / 用户批准 / 拒绝 / 批准过期 /
                   预留 / 初始额度 / 余额重建 / 库存发放与消耗 / 算力额度）/
                   EVENT_TYPE × ownership evidence 矩阵 /
                   四个证据分支各自独立成立 /
                   对抗性交错证明"先分页再筛"会漏掉**最新**的一段 /
                   一份独立 oracle 正反两向交叉核对 /
                   历史与坏 JSON 形状不让整条读面打不开 /
                   §6 gift 语义（recipientId 不算归属）/
                   §8 投影不是第二权威（同一 revision 在两个读面上逐字相同）。
                   ★ 零子进程、零 socket、零浏览器。
         http     —— 真实 in-process Home Node + 真实 socket（**恰好一个**，
                   不 spawn、不开第二个）：ownerId 真的下到 canonical query /
                   带与不带 ownerId 是两条语义 /
                   order 只能与 ownerId 同时出现 / 分页在 HTTP boundary 上
                   完整 / 旧的全局读面形状没变 / POST 一律 405。 */
      ['test_p22_19_economy_read_contract.js'],
      ['test_p22_19_economy_owner_scope.js'],
      ['test_p22_19_economy_owner_scope_http.js'],
      /* P22-20：Economy 的**外部边界**审计（这一阶段刻意不新增任何
         Economy 能力，也不实现 Exchange / Refund）。
           ① external boundary —— §1 的七行外部能力矩阵（Provider billing /
              Provider quota / Real payment / Refund / Exchange / Merchant /
              External order）每一行的"存在 / 不存在"都由**真实文件里的逐字
              证据**决定，而不是由名字决定；Economy 侧对七类能力的**调用形态**
              为 0，代码里出现的每一个外部词都必须在"冻结词表 / 恒 false 自述"
              两类声明里（新增一个未声明的词就红）；§2 的依赖闭包恰好是七个
              Economy 文件 + runtime/db-failure.js，内建只有 sqlite / crypto /
              http / path / fs，零 process.env、零 createServer、零 SDK；
              §4 支付方向（合法方向存在且唯一、非法方向没有代码、counterparty
              是封闭集合）；§5 Compute = 库存资产（含"那句否认真的被渲染出来"）；
              §6 Refund 停在词表层的三个位置与四个缺口；§7 Exchange 的
              0 capability 与两道币种闸门。纯 Node，不 open 数据库。
           ② boundary injection —— §3 四种资源注入（USD / CNY / TOKEN /
              API_BALANCE × 钱包/预算/商品/报价四入口，**带差分控制组**，控制组
              必须被接受，于是拒绝可归因于币种）；§10 Provider 13 键 × 5 值 ×
              三个入口 + 配置面 39 + 信封 16 次注入全部 DENY；Payment 那一节
              **让支付模块真的可解析**（重定向到临时桩）再断言 Economy 零 import；
              Exchange 让 convertCurrency 真的存在再跑完整读写面；Refund 的两件
              不存在；capability 反例（14 词 × 4 consumer）。真实 store，
              零子进程 / 零 spawn / 零浏览器 / 零 socket。
           ③ public surface —— 解析 docs/contracts/economy/ECONOMY_PUBLIC_SURFACE.md 并与真实
              路由表 / 三个 seam 的 path 与词表 / 契约的 CAPABILITY 逐个比对；
              本进程一个真实 HTTP（socket = 1）：28 条读面可达、每条 POST 都
              405 economy-is-read-only、九个未来能力路径 GET 404 / POST 405、
              这一整轮之后 change log 逐字不变、三条写面匿名写不进去；
              §9 把三个真实渲染器挂在 DOM 桩上，把页面上**每一个按钮的文案**
              收出来与冻结词表比对（多一个 / 少一个都红），并断言商品卡上
              没有任何按钮、页面上没有表单与 submit。 */
      ['test_p22_20_economy_external_boundary.js'],
      ['test_p22_20_economy_boundary_injection.js'],
      ['test_p22_20_economy_public_surface.js'],
      /* P22-21：Economy v1 的**最终闭包审计与冻结**（这一阶段刻意
         production diff = 0，也不实现任何 future capability）。
           ① freeze —— 解析 `docs/contracts/economy/ECONOMY_V1_FROZEN_CONTRACT.md` 的每一张表，
              与真实代码逐格比对：schema 水位 / 28 条读面 + /security /
              三条写面及其词表与信封 / capability 与 consumer 矩阵 /
              六个币种 / 两个资产类别 / 52 个事件类型 / 六个状态机的
              状态与转移 / 外部边界（含"实际 require 说明符恰好 8 个"）/
              九个 UI 模块 / 七个生产文件。★ 每一个集合比较都**报成员名**
              （`newInCode_notInManifest` / `inManifest_butGoneFromCode`），
              并带一句 verdict：新增路由 / REFUND / PROVIDER_TOPUP / 第 8 个
              Economy 生产文件都必须声明新阶段，而不是静默扩 v1。
              `FUTURE_NOT_PRESENT` 的 11 个词逐条区分"标识符存在"与
              "capability 存在"（`REFUND` / `EXCHANGE` 只出现在账本交易类型
              词表里），并有守卫**灵敏度自测**（往 manifest 的内存副本里注入
              一条哨兵，断言 diff 逐名报出它）。纯 Node，零 socket。
           ② golden path —— 一次真正的 fresh install：真实 buildHomeNode +
              真实 HTTP + 真实 SQLite。BOOTSTRAP_CREDIT → PUT_BUDGET_POLICY
              → PUT_AUTONOMY_POLICY → 目录 fixture（显式标记目录管理面
              **故意不在** v1 公开面上）→ Active command → Intent
              (WAITING_APPROVAL) + Approval(PENDING) → 用户决定 seam APPROVE
              → resume → 购买 COMPLETED → 账本一笔平衡交易 → 库存恰好发放一次
              → owner-scoped 时间线不泄漏另一个 owner → UI 纯层投影显示的
              就是 canonical 最终状态。另有 §1 authority graph（用一层**只读
              记账代理**记录真实的 `调用者文件 → store 方法` 调用边，shortcut
              edge 逐一为 0）、§5 exactly-once 七层重放（producer / transport
              / intent / decision / resume / settlement / restart 之后，购买数、
              库存量、账本 delta 三者逐字不变）、§10 六条失败金路径
              （预算拒绝 / 批准拒绝 / 批准过期 / 报价过期 / 重复请求 /
              畸形权威注入）。★ 本进程两个实例、每个恰好 1 个 socket，
              零 spawn、零浏览器；临时目录在 exit 上退避删除。
           ③ closure audit —— §0 阶段账本（22 个 authority 各恰好一个定义点：
              C = 0 / D = 0）· §2 写面普查（39 个经济 mutation 动词逐类计数：
              生产可达 7 · 内部编排 32 · tests-only 0 · dead 0 ·
              suspicious bypass 0，并单独证明唯一的"读面传递可达写"是
              派生缓存修复）· §3 读面普查（CODE−DOC = 0 且 DOC−CODE = 0，
              两份文档互相一致）+ owner-scope 对抗性 fixture（交错噪声 +
              分页截断取最新一段）· §4 四个状态机叉积（可达组合由真实
              fixture 生成，六个"不可能但可观测"的候选逐条证伪）·
              §6 崩溃边界（一次结算 = 恰好一个事务，`COMMIT` 只出现在
              withTransaction 里）· §7 四资源的四条"无路径"证明 ·
              §8 UI authority（六条泄漏形态零命中）。零 socket。 */
      ['test_p22_21_economy_v1_freeze.js'],
      ['test_p22_21_economy_golden_path.js'],
      ['test_p22_21_economy_v1_closure_audit.js'],
      /* Release Tooling R1：Release Builder（本地发布编排器，tools/release-builder/）。
         ① plan：纯规划 + 状态机 + 顶级状态 + **结构断言**（工具里不存在第二份
            版本源 / 清单生成器 / semver 比较 / 四等式 / 密钥词表；只有
            lib/canonical.js 允许 require 仓库真源）。
         ② astages：在 %TEMP% 的临时检出里跑完整 CHECK→BUILD→VERIFY→SEAL，
            再做**对照证明** —— 逐一故意破坏构建退出码 / 产物缺失 / 截断 /
            产物名 / PE 版本 / 陈旧 SHA256SUMS / 清单版本 / 清单 sha / 未注册通道 /
            清单与产物不一致 / 非法 VERSION / 非升级目标 / README 声明漂移 /
            README 锚点消失 / 已存在的 tag / 残留 staging / 脏工作树，
            确认每一种都能把 READY 打回 BLOCKED；另含 PUBLISH 必须带确认、
            确认串绑定产物指纹、Dry Run 逐字节零副作用、日志脱敏。
         ③ server：本地服务契约 —— 只绑 127.0.0.1、逐接口要 boot token、拒绝跨源、
            静态路径不能逃出 public/、阶段门在服务端、一键流程不含 PUBLISH、
            PUBLISH 无确认即拒、Dry Run 不改任何文件。
         ④ exe（需要已构建的 tools/IB-Release-Builder.exe；未构建则跳过并返回 0）：
            真启动那个双击用的 EXE —— 确认它找到的是**仓库内置** runtime\node\node.exe
            而不是 PATH 上的 node、确认 IB_RELEASE_NO_BROWSER=1 下它真的是纯服务宿主
            （browserOpens===0，且日志不得声称打开了浏览器）、确认 GUI 页面与
            /api/snapshot 报的是**真实**版本、无 token / 错 token 一律 403、
            静态路径不能穿越、杀掉 EXE 后不留 node 子进程（Windows Job Object）。
         四者都**不联网、不安装**；只有 ④ 会监听一个本地 127.0.0.1 端口（不开浏览器），
         全都不碰真实 dist/；临时目录由套件自己断言已删除。
         真实 ISCC 构建仍只在 test_installer_build.js --force 里跑。 */
      ['test_release_builder_plan.js'],
      ['test_release_builder_astages.js'],
      ['test_release_builder_server.js'],
      ['test_release_builder_exe.js'],
      /* P35 Packaging Control Plane: schema contract, read-only preflight,
         deterministic planning and read-only artifact validation. The suites
         use isolated synthetic fixtures and never build or install.
         R2-G2：脚本名按 tools/packaging-control-plane/tests/ 的**真实文件名**登记
         （此前带 `packaging_` 中缀的 6 个名字指向不存在的文件）。 */
      ['test_contract.js'],
      ['test_environment_inspector.js'],
      ['test_build_planner.js'],
      ['test_artifact_validator.js'],
      ['test_manifest_writer.js'],
      ['test_executor.js'],
      /* P35.6 · same-origin packaging API gate, UI state mapping and safe request surface. */
      ['test_packaging_center_api.js'],
      ['test_packaging_center_ui.js'],
      /* P22-18 的浏览器视觉核对（test_p22_18_economy_experience_visual.js）
         与 P22-15/16/17 那三条一样**不在**默认套件里（它要开一个真实
         浏览器）：2 主题 × 4 宽度（含 320px）+ 截断/空/展开四种状态。
         跑法：node tests/test_p22_18_economy_experience_visual.js
         ★ P22-19 **没有**新增视觉矩阵：它只改了读取逻辑与两句文案，
           UI 的结构、类名、节点顺序都逐字未变 —— 因此按 §13 的要求
           **不**重跑完整矩阵，只跑 P22-18 那一条既有回归。
       /* P22-22 的浏览器视觉核对（test_p22_22_economy_empty_state_visual.js）
          与 P22-15/16/17/18 那四条一样**不在**默认套件里（它要开一个真实
          浏览器）：3 个 §F 尺寸（1280×800 / 1440×900 / 390×780）× 两套主题，
          量的是空状态那一块的真实高度、线稿的等比缩放、标题/状态/说明三档
          对比度、技术说明默认折叠、以及"这不是错误页"。
          跑法：node tests/test_p22_22_economy_empty_state_visual.js
          ★ 这一阶段**只**动视觉与文案层：services/ runtime/ 的 diff 为空，
            路由、契约、能力判定与测试语义一条都没有改。 */
      /* P22-23：Economy 首次使用链的**运行时**闭环。
         在此之前那条链从未被证明过：服务端凭据只从 process.env 来、浏览器
         那份从来没有代码写过，两端都是空的，于是配置面永远 503「请先设置
         环境变量」。真正的问题不是那句话，是**凭据从没被创造过**。
         这一条**真实 spawn services/home-node-service.js**（私有端口 + 私有
         数据目录，无 IB_HOME_NODE_TOKEN），证明：凭据自动 provision 并持久化 /
         本机交付面只认 loopback Origin（外来源 / null / 无 Origin / 缺协议头
         四种形状逐个被拒）/ 拿到凭据后配置 seam 是开的 / **wallet 仍然没有
         被自动创建** / 用户提交之后 wallet 才 READY / 重启不换凭据、不重复
         铸币、balance 不变 / mismatch fail closed / secret 不进日志与响应 /
         env 与 headless override 语义逐字未变。
         ★ 它要验的就是**产品默认**（自动 provisioning），因此本套件自己显式
           设置那个开关，不依赖运行器的隔离姿态。 */
      ['test_p22_23_home_node_provisioning.js'],
      /* P22-24：Not-Found **wire contract**（anti-leak）。
         一条 **canonical 裁决词**（DENY_REASON，SCREAMING_SNAKE）被当作
         client-facing error token 发出去，是一整类回归而不是一处笔误：store 的
         denied 结果里同时带着 reasonCode（裁决词）与 errors[]（面向客户端的资源
         token，kebab-case），seam 只要写成 `reasonCode || errors[0]` 就会把两个
         词表混起来。实测抓到两处（/economy/approval 发 APPROVAL_NOT_FOUND、
         /economy/autonomy-policy 发 POLICY_NOT_FOUND），后者让 Economy 设置页
         「自主购买」在**全新 owner** 上显示「读不到自主规则 + 再试一次」，
         而"尚未配置 → 首次配置表单"那条分支在产品里从未执行过。
         这一条守卫证明四层：① 真实节点上 11 条只读缺席面全部 404 + kebab-case
         资源 token；② 那些 token 不是任何 DENY_REASON 成员（判据是**结构**的：
         裁决词是 SCREAMING_SNAKE、客户端 token 是 kebab-case，交集为 0）；
         ③ 同一份真实 payload 喂给 production UI core 得到 state=absent，而真
         transport 失败仍然 state=unknown（证明的是**分离**）；④ 源码级：http.js
         里所有"缺席即 404"的 error token 一律不是 reasonCode。
         ★ 判据**限定**在这 11 条只读资源面上：写面（/internal/economy/…）的
           信封本来就把 reasonCode 当 reasonCode 发，本条守卫不全局禁止
           reason code 出现在响应里。零浏览器（一个真实 Home Node 子进程 +
           私有临时数据目录 + 显式测试凭据，结束即清理）。 */
      ['test_p22_24_not_found_wire_contract.js'],
      /* P22-24 的**真实浏览器**验收（test_p22_24_fresh_owner_autonomy_ui.js）
         与 P22-15/16/17/18/22/23 那几条一样**不在**默认套件里（它要开一个真实
         Chromium）：fresh owner → 404 + 客户端缺席 token → production core
         state=absent → **真实的自主购买表单出现**（不是"读不到 + 再试一次"）
         → 填表 → 保存 → 权威侧真的落一条策略 → 页面进入 configured；
         另含对照面（真 transport 故障仍给 Retry 且不给表单）、Internal/Infernal
         两个外观与 390 窄屏。截图只落 %TEMP%。
         跑法：node tests/test_p22_24_fresh_owner_autonomy_ui.js */
      /* P22-25：Economy Catalog Bootstrap —— 目录的**唯一** authority。
         P22-24 §7 留下的缺口是"写方存在、读面齐备、GUI 只读、无 seed、
         无 bootstrap —— 那么谁把第一件商品放进去？"这一条守卫钉住五条
         **结构性**性质：① 空目录 → canonical 初始目录（固定 id、ACTIVE、
         价格/单位/交付形态全部由契约**派生**）；② 第二次 bootstrap 不重复
         创建（而且全局 revision 与 change log 一字不动，即"根本没写"而不是
         "写了但值一样"）；③ 用户已有的货架/商品永不被覆盖（写路径在目录
         非空时一次都不发）；④ 图片引用是**仓库里的一个文件**，拿掉它模块
         载入就抛（fail closed），且 asset key 的形状里没有 `:`/scheme/base64；
         ⑤ 种子不碰钱（change log 里只有 STORE_CREATED + PRODUCT_CREATED）。
         外加本阶段禁止面的可断言形式：capability 词表里没有 CREATE_PRODUCT、
         Agent 与 User 请求它都是 CAPABILITY_DENIED、http.js 的代码里 putStore/
         putProduct 仍然零调用形态。零浏览器，一个私有临时目录。 */
      ['test_p22_25_catalog_bootstrap.js'],
      /* P22-25 的**真实节点**验收：一个全新 Home Node 子进程 + 私有数据目录 +
         显式凭据，站在 HTTP 外面看到什么 —— fresh install 之后
         /economy/stores 与 /economy/products **不为空**；每一行都带
         `image`（asset key）+ `imageUrl`（/assets/economy/… 之下）；那些 URL
         真的取得到 200 + image/webp；不存在的那张图是 404 而**不是** HTML
         回落；/economy/* 的六种写尝试一律 405（商品集合一件不多）；不带凭据
         读目录仍然 401；**同一数据目录重启一次**之后目录一字未增（日志上是
         economy-catalog-bootstrap-skipped，而不是 seeded）。
         ★ 图片由桌面静态层（IB_WEB_PORT，默认 23120）服务；那一层不在时
           自动退回 Home Node 带凭据取一次，并如实标注走的是哪条路。 */
      ['test_p22_25_fresh_catalog_wire.js'],
      /* P22-26：Economy 商品生命周期闭合 —— 四处断点（一处买不了 / 一处算错 /
         一处边缺失 / 一处重复词表）修掉前三处，第四处明确不动（独立阶段）。
         ① 份数契约：`quotes` 加一列 `units`（schema 7 → 8，非空迁移、只加列），
            prepare / approval / intent 三处下游**只**从报价那一列读份数，请求里
            带 units 也**不参与**；units = 1 / 3 /（grantQuantity=1000, units=3）
            三条黄金路径 + 旧单数量语义兼容 + 坏输入 fail closed + 幂等。
         ② 消耗缝：唯一的 runtime seam `consumeOwnedItem` —— owner 只来自权威
            上下文（payload 自报被完全忽略）、只接受 productId、只有 CONSUMABLE
            能被用掉、不动钱包 / 账本 / 预算 / 批准，且**没有**接上 HTTP /
            capability / 命令通道 / 动作适配器 / UI（生产调用方 0）；两个真实
            进程同时扣 ⇒ 恰好一个成功、数量不为负。
         ③ 目录 v2：不发布买不了的 SERVICE（载入期断言由 kind → fulfillment →
            settlement primitive 的**派生链**判定，而不是手写名单），每件加一个
            只用于展示的 rarity（不进 products 表、不进 DTO、经济代码零命中）；
            非空目录一次写都不发（用户已有的店与商品永不被覆盖）。
         ④ 派生链与 `PRODUCT_INPUT_KEYS`（13）逐字冻结：没有 effect / behavior /
            category 第二套词表，发货只有一个调用点。
         四条都在真实 store + 真实 SQLite 上跑（③ 另含"把一件 SERVICE 塞进种子
         ⇒ 模块载入期真的抛"的对照证明；② 含多进程夹具）；零浏览器。 */
      ['test_p22_26_product_units.js'],
      ['test_p22_26_inventory_consume.js'],
      ['test_p22_26_catalog_v2.js'],
      ['test_p22_26_product_fulfillment.js'],
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
      /* P23 Phase 1：Voicebox 本地运行时适配器 —— 上游 REST contract 的请求 shape /
         profile 解析 / 轮询 / 错误分类 / offline 不回落别的 provider，最后用真实 Bridge
         子进程验证「Voicebox offline 不影响纯文字聊天与旧 TTS 路径」。 */
      ['test_voicebox_provider.js'],
      ['test_active_http.js'],
      /* M1-A：Home Node canonical chat authority（真实 HTTP + 临时数据目录） */
      ['test_home_node_http.js'],
      ['test_home_node_service.js'],
      /* M1-C.2d Wave 1：**执行缝**（NodeModelPort.runStream → executeCharacterTurn →
         canonical chat store）此前存在但未登记，因此从未随全量套件运行。
         它是当前唯一覆盖 Home Node 执行链真实 SSE 往返的测试。 */
      ['test_home_node_execution.js'],
      /* M1-C.2i：Middle Brain 收敛在**生产装配**上的证明。test_middle_brain_convergence.js
         自己 createExecutor，因此它证明"执行器接上执行缝之后行为正确"，不证明生产装配
         真的接上了 —— 本仓库已经因为这类缺口吃过一次亏（canonical memory 只在
         buildHomeNode 里接好，进程级启动路径漏了）。这一条走 buildHomeNode() + 真实回环
         provider，把服务端收到的请求体抓下来断言（上下文替换 / 思考深度 wire 字段 /
         未发布策略时行为不变）。 */
      ['test_home_node_middle_brain_assembly.js'],
      /* M1-B：Mobile Gateway 协议 / 鉴权 / LAN 硬门 / secret-leak 契约
         （真实服务实例 + 真实进程，临时数据目录 + 随机端口） */
      ['test_mobile_gateway_http.js'],
      /* M1-C.2b.2：runtime spec write boundary —— 关闭 OQ-1 实证的
         `projected.spec || entry.spec` 回落（raw spec 曾可把 imageGenApiKey
         原样写进 character_runtime_specs）。走真实 publish HTTP 边界 + 落盘断言。 */
      ['test_mobile_publish_spec_boundary.js'],
      /* M1-C.2c-A：P0 角色连续性 —— 手机上的她是否知道
         用户是谁 / 怎么称呼 / 什么关系 / 现在几点（persona 与 history 是回归）。
         真实 publish → pair → chat.send → NodeModelPort → mock provider，
         断言 provider 真正收到的 system。 */
      ['test_mobile_p0_continuity.js'],
      /* M1-C.2d Wave 2：canonical memory 连续性（产品定义测试）——
         真实 canonical memories → Node 召回（共享 memory-retrieval-core）→
         chat.send → executeCharacterTurn → NodeModelPort → mock provider。
         三条独立证明：provider 收到选中的记忆；**同一个回合**里 SSE /
         chat.history / character.list / character.get 都不含它；
         桌面写入的记忆能影响一次**后来**的 Android 回合。
         外加：隐藏记忆不进 provider 输入、可见性先于排名、
         激活不推进 memory revision、/mobile/v1/memory/* 一律 404。 */
      ['test_mobile_memory_continuity.js'],
      /* M1-C.2k：canonical **线索**（open thread）连续性 —— 线索此前只有浏览器
         6 小时心跳能产出，Home Node 读不到，于是同一份 canonical Middle Brain
         在两端拿到不同证据（organized.threads 1 vs 0；threadItems 3 vs 0），
         而 multipleThreads（threadItems>=2）是 Gate 的**无视冷却硬触发**，
         两端因此给出不同判定。本文件用 production-shape E2E 证明：
         派生已收敛成唯一实现（thread-derivation-core.js，浏览器与 Node 同一份），
         Home Node 按需从 canonical memory 派生 → provider system 真的含线索块、
         隐藏线索与不命中规则的记忆都不成为线索、快照三态可区分、
         Android 协议仍不暴露任何线索（/mobile/v1/thread/list 404）。
         不建 Home Node 的 threads 表：线索是 canonical memory 上的确定性函数。 */
      ['test_mobile_thread_continuity.js'],
      /* M1-C.2k 对照证明：单向拆掉共享线索派生的三个面，分别复现
         "Home Node 无线索 → threadItems/multipleThreads/判定全部退回"、
         "跳过可见性 → 隐藏线索进入证据"、"两端各写一套规则 → 证据集漂移"。
         只改内存替身，不改生产代码。 */
      ['test_mobile_thread_counterproof.js'],
      /* canonical memory **生产装配** parity（那次 404/501 事故的回归）——
         真实 spawn 生产入口，证明 /memory/list、/memory/settings、
         /memory/changes 在**进程级装配**下也进得了 handler（404 no-route =
         路由没进进程；501 UNSUPPORTED = 路由进了但 memoryStore 没接线），
         外加"生产装配与 buildHomeNode 装配的 canonical memory 依赖不得再次漂移"。
         为什么不合并进 test_mobile_memory_continuity：那个文件断言的是
         **产品语义**（召回是否进入 provider），全程用 buildHomeNode 隔离实例；
         而这次事故的根因只有"真实进程装配"能覆盖。 */
      ['test_home_node_production_memory_assembly.js'],
      /* M1-C 修复（D21）：LAN 门 —— allowRemote 只在"显式非 loopback 绑定 +
         设备鉴权真实就绪"时打开。所有"远端"请求都发往本机**非 loopback 地址**，
         因此源地址也是非 loopback（用 127.0.0.1 永远走不到这条规则）。
         真实服务进程 + 真实故障注入（devices_schema 过新）。 */
      ['test_home_node_lan_gate.js'],
      /* M1-B：未来 Android 视角的端到端验收 —— 一个普通 HTTP/SSE 客户端走完
         pair → authenticate → character.list → chat.history → chat.send →
         streaming → reconnect/resume → sync.changes → retry → revoke */
      ['test_mobile_thin_client.js'],
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
      ['test_recovery_webcore_adapter_browser.js'],
      ['test_game_smoke.js'],
      ['test_chat_smoke.js'],
      ['test_workspace_smoke.js'],
      ['test_memory_smoke.js'],
      ['test_active_diary_smoke.js'],
      ['test_moments_smoke.js'],
      /* M1-C.2n：浏览器侧接线（真实 Chrome + 真实 file:// 承载）——
         "浏览器里的可见性判定与 Node 判定逐位一致"、"生产函数真的调共享核"、
         "getMomentsContext 与 Node 渲染逐字相同"，以及最关键的
         **canonical 承载下任何直接 dbPut/dbDelete('moments') 必须被拒绝**
         （moments-write-closed / moments-delete-closed）且行仍在。
         本文件此前因自建 CDP 客户端发送未掩码帧而静默挂死，故未登记；
         修好掩码后它才有资格进入自动套件 —— 这也把 P6 的"浏览器侧接线"
         从**结构性证据**升级为**真实浏览器证据**。 */
      ['test_moments_browser_authority.js'],
      ['test_moments_phase2_smoke.js'],
      ['test_moments_phase3_smoke.js'],
      ['test_moments_user_smoke.js'],
      ['test_socialnet_smoke.js'],
      ['test_socialnet_chain_smoke.js'],
      ['test_activity_smoke.js'],
      /* Role DM Phase 4B-1.2：披露事实写入路径的**真实浏览器**证据。
         Node 侧的 test_disclosure_authoring.js 用内存 mock 顶替 IndexedDB，
         因此它证明不了"v24 的 onupgradeneeded 真的建出了 disclosureFacts"
         "它的 keyPath 真的是 factId""页面里真实的 getMemoryContext 读不到它"。
         本文件在真实 Chrome + 真实 file:// 页面上跑真实 IndexedDB：
         store 与 keyPath、真实 create/list/update/delete、A/B 分区、
         四条拒绝路径、memories 零写入、真实 getMemoryContext 盲区、
         UI 小节只暴露三档。临时 profile，不触碰真实用户数据。 */
      ['test_disclosure_store_smoke.js'],
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
      ['test_secret_routes_cdp.js'],
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
      /* P11-3：真实普通单聊请求的逐层 [MiddleBrain Trace]（含 local 回落注入 / bypass / provider 中立性） */
      ['test_middle_brain_trace.js'],
      /* P11-2A：角色一致性校准（Layer B · 离线 mock 真实执行路径；--live 才接真实端点） */
      ['test_middle_brain_calibration_live.js'],
      /* Astra Readiness Phase 1 · 有界离线观测跑（与上一行同一个 harness，只是换了
         语料与阶段）：A–U 观测语料 + judge/rewrite/verify 三段全跑 + §12 安全包络
         （预算先声明、平台层写绊线、document-start 网络白名单守卫）。
         为什么必须登记：这些断言只有真的跑一遍才算证据，而离线跑不花一分钱。
         规模刻意压到 6 条样本（最坏 18 次本机 mock 调用）。 */
      ['test_middle_brain_calibration_live.js', '--corpus=readiness', '--rewrite', '--verify', '--max-cases=6', '--budget=24'],
      /* P21：统一思考深度 · 真实请求链（本地 mock 端点记录最终 wire body）：
         MB disabled 零注入 / auto 与关闭逐字节相等 / 逐档映射 /
         DeepSeek 模型级校准（P21.1：auto 与 baseline 逐字节相等、low/medium/high/max、
         未登记 model 继续 abstain）/ chat×diary parity / Speed 分离 /
         requested→effective→reasoning tokens 可对比 */
      ['test_middle_brain_reasoning_effort.js'],
      /* Cache Audit baseline 身份隔离（真实 chat→diary→chat 行为链） */
      ['test_cache_audit_isolation.js'],
      /* Phase 1 · 可选上下文按需注入：5 个用例（闲聊不带可选块 / 工作区·日志·生图按需保留 /
         first_chat diary persona 只出现一次，含真实请求体核对） */
      ['test_chat_context_lazy_injection.js'],
      ['test_moments_phase4_smoke.js'],
      ['test_runtime_browser_audit.js'],
      ['test_runtime_optin_smoke.js'],
      ['test_runtime_convergence_proactive.js'],
      ['test_runtime_convergence_moments.js'],
      ['test_runtime_convergence_diary.js'],
      ['test_runtime_convergence_phase4.js'],
      ['test_context_convergence_c1.js'],
      /* P24-M1.1 · 群聊 trace runtime binding 回归（真实浏览器 + 真实群聊回合）：
         修复的缺陷是"群聊分支引用裸 `_mbTrace`（唯一 var 声明在单聊分支）⇒ 每个成员
         回合都抛 TypeError 且被成员级 catch 吞掉 ⇒ assistant message = 0"。
         本测试在三条件下各发一次真实群聊：sink 存在 / sink 缺失 / sink 自身抛错，
         断言 canonical 回复照常落库、M1 identity metadata（groupTurnId / speakerId /
         groupOrder / turnId / sequenceIndex）确实进入消息，且单聊不受影响。 */
      ['test_group_runtime_trace_binding.js'],
      /* P24-M2 · Speaker Identity & Visibility Foundation（身份读路径迁移）：
         canonical `metadata.speakerId` 取代 `senderName === selfName`；同名角色不再
         互相把对方的发言当成"自己说过的"；legacy 走唯一精确匹配、歧义 fail closed；
         不对称安全规则（UNKNOWN 永不判 SELF）；不写库、不回填、无迁移。
         纯契约 A–O + 真实浏览器同名 E2E（检查真正进入 provider 请求的 context 角色映射）。 */
      ['test_group_speaker_identity.js'],
      /* P24-M3.2 · Participation Planner Production Integration（参与权威切换）：
         canonical mention resolution（精确 token、无子串、同名 ambiguous ⇒ 不点名任何人）
         → planParticipation → plan.entries → 逐成员 MemberTurn；groupOrder 取自 entry.order
         （运行期失败留下合法空洞，不重编号）；planner 校验失败 / 抛错一律 FAIL CLOSED
         （零 provider 调用、零 assistant 消息、无 legacy 回退）；被 omitted 的成员不参与
         API 就绪校验；空计划不调用任何 provider。真实浏览器 + mock provider。 */
      ['test_group_participation_integration.js'],
      /* P24-M3.3.1 · GroupTurn Lifecycle & Cancellation Foundation（runtime-only）：
         created → planning → planned → executing → completed | cancelled；
         entry 边界检查 cancelled ⇒ 不启动 provider / 不产生 assistant 消息 / 不改 groupOrder；
         stopStreaming 只翻 cancel 标记（当前流式成员仍走既有 st.ac.abort，无第二套 abort）；
         已完成消息保留；单聊、fail closed、empty plan 行为不变。真实浏览器 + mock provider。 */
      ['test_group_turn_cancellation.js'],
      /* P24-M3.4.2 · Participation Policy Adapter Integration（resolver 接入 production
         GroupTurn planning path）：真实 resolver 收到三份 undefined ⇒ 空 policy、window 回落
         adapter fallback=2；再用最小 monkey-patch 预验证未来 policy 形状（max=2 由 planner
         裁剪 / window=0 真的关闭 / max=0 走 planner 空计划而非 runtime skip / window=5+max=2
         同时映射）；resolver 抛错 ⇒ derive 与 planner 都不被调用（fail closed）。
         ★ 本套件使用 CDP（真实浏览器 + mock provider）⇒ 归 browser 组。 */
      ['test_group_participation_policy_integration.js'],
      /* P24-M3.4.3 · Group Participation Policy Storage（group-owned storage 契约）：
         canonical owner = group object（groups store，keyPath='id'，schemaless，无 DB bump）；
         shape = {maxResponders?,recentSpeakerWindow?}（非负有限整数，0 为显式值）；
         字段缺失 = 未配置、两个都缺则删除整个键（绝不存 {}、不 backfill 老群）；
         唯一 validation authority = core policy validator（storage 不复制第二套校验）；
         唯一 storage authority = social.js set/clear helper；非法 update 原子（旧值不变）；
         production 只从**已加载**的 group object 读 policy（不新增 DB 读），
         invalid/unknown stored policy ⇒ 整轮 fail closed；policy 快照每 GroupTurn 一次
         （轮内改 policy 下一轮才生效）。真实浏览器 + mock provider。 */
      ['test_group_participation_policy_storage.js'],
      /* P24-M3.4.4 · Group Participation Settings UI（UI + canonical mutation adapter）：
         section 放在**既有**成员管理弹窗内（不新建页面/管理器）；保存模型与成员操作一致
         = 即时保存，但每次 change 都是**一次原子 desired-state 保存**
         （desired 空 ⇒ clear；否则 ⇒ exact replace；每次恰好 1 次 groups 写 = 无 partial save）。
         「未设置」≠「0」（0 可显示/保存/重开恢复；fallback 2 只在 UI 里说明、绝不写库）；
         非法输入被拒绝且不 clamp、旧 policy 不变；非法 stored policy → 显示"数据无效" +
         「重置参与策略」（显式 reset，唯一能清掉非法 policy 的路径，绝不自动修复）。
         真实浏览器 + 真实 IndexedDB + mock provider：E1–E7 证明 UI → canonical storage →
         既有 production chain（planner 仍是唯一截断权威）。 */
      ['test_group_participation_policy_ui.js'],
      /* P24-M3.5.1A · Structured Target Identity Foundation（显式 targeting 的地基）：
         text mention → canonical targetSpeakerIds（写入**群用户消息** metadata，始终写、
         无 target 时是空数组）→ runtime projection → 既有 mentioned:boolean → planner v3。
         冻结：field presence = structured authority（空数组也权威，绝不回退文本解析）；
         field missing = legacy（走文本解析，不回填、不重写历史）；非法 structured ⇒ fail closed；
         历史已退出成员的 id 允许留在事实里、projection 只映射当前参与者；数组顺序无语义
         （canonical 写入按 participant 顺序）；每 GroupTurn 解析一次 + 投影一次 + 用户消息
         恰好一次 canonical write；planner / planVersion / policy / P23 / MB / Memory 零改动。 */
      ['test_group_explicit_targeting.js'],
      /* P24-M3.5.1B · Historical Targeting Compatibility & Replay Hardening（hardening 阶段）：
         structured 事实在历史读取中原样保留（含已退出成员的 id），成员映射只在 projection；
         metadata 缺失/null/非 object ⇒ legacy（不炸历史）；corruption ⇒ TARGETING_CONTRACT fail closed
         且绝不文本回退、不回显原值；rename / 改名碰撞 / 退群 / 重新加入 均不改写历史 fact；
         历史读取、rename、成员变更、legacy 回退、corrupt 读取 ⇒ **0 次 chatMessages 写**；
         display ≠ planning（损坏 metadata 仍能正常显示 content，不妨碍后续回合）；
         provider history 不含 target ids；IDB 与 export→import 均保留 [ids] / [] / **missing** 三态区分；
         静态证明 **不存在** 生产 GroupTurn replay（未来 replay MUST use persisted structured ids）。 */
      ['test_group_targeting_history.js'],
      /* P24-M3.5.2A · Dynamic Runtime State Foundation（runtime-only 准入队列 + hard gates）：
         feature **默认关闭** ⇒ 与既有 static runtime 逐字等价（零额外模型调用 / 消息 / metadata）；
         纯 helper：createDynamicRuntimeState / nextDynamicRuntimeEntry / mark* / snapshot，
         校验 initial plan（speaker 与 order 唯一、order 非负整数、cap 合法；洞 0,2 合法），
         hard gates = cancel（读 _gTurn.cancelled，**无第二 authority**）/ one MemberTurn per speaker /
         removed deny / cap 不超 / muted 由 planner 准入、runtime 不否决；
         DEFER/SILENT/INTERJECT 均**未实现**（INTERJECT 因无可实施人群与 identity/序号缺口而 deferred）。
         真实浏览器：STATIC vs FOUNDATION 差分基线（provider 顺序/次数、canonical 行、groupOrder、
         turnId 派生、DB 读写计数、metadata 键集合全等）+ 失败隔离 / 取消 / muted / removed / cap /
         typing / 单聊。 */
      ['test_group_dynamic_runtime.js'],
      /* P29-0 · Identity Read-Path Closure（撤回 / 拍一拍等 ownership 读路径必须走
         canonical id）：撤回目标的选择不再用 `senderName ===`（同名角色 A 会撤回 B 的
         消息）。判定入口复用 M2 的 `resolveSpeakerId`/`classifyMessageForSpeaker`
         （speakerId 优先；legacy 唯一精确名回退；同名歧义 ⇒ UNKNOWN ⇒ 永不 SELF）；
         群聊透传本轮已有的 participants，单聊取当前角色一个参与者；
         `_gMember === null` 的身份退化新增**可诊断信息**（计数 + 闭集日志，
         不写 metadata / DB / prompt，fallback 语义不变）。
         测试：I1 同名撤回隔离 · I2 speakerId 优先 · I3 legacy 保持 ·
         I4 退化可诊断 · I5 无新 authority · I6 P24 不回归（真实浏览器 + 最小 mock provider）。 */
      ['test_identity_read_path_closure.js'],
      /* P29-3 · Workspace Actor Identity（canonical attribution preservation）：
         producer 在 `_execWsOps` 当场保留 `actorId = cfg.id`（四类 runtime item：
         read / op-feedback / run-output / tool-result），actor 仍是 display-only；
         group reader `_gInjMine` 改 canonical-first（actorId 命中即归属；缺失 ⇒ legacy
         唯一精确显示名；歧义/非法/无法解析 ⇒ not mine），无主条目保持既有首轮兜底；
         1:1 take-all / image drain / projectFiles / session scope 均不变。
         真实浏览器：四类 producer 形状 + cfg 边界（null/primitive/无 id）+ 同名隔离 +
         canonical precedence + legacy 唯一与歧义 + foreign actorId + 无归属兜底。 */
      ['test_workspace_actor_identity.js'],
      /* P30-2 · Workspace Conversation Scope（P30-1 契约实施）：
         producer 把既有 ictx 的 (friendId, threadId) 写入四类 runtime item（additive）；
         consumer（群/1:1/tool continuation）只消费同会话条目，**不匹配项留在队列**；
         scope 缺失（legacy / guard breaker / 手动脚本）保持旧行为（actor 规则 + 首轮兜底）；
         比较键只来自 chat-core.conversationIdOf；image/blog 明确排除（各自 follow-up）。
         覆盖 C1–C8（真实 producer/consumer + 源码守卫）。 */
      ['test_workspace_conversation_scope.js'],
      /* R4-2 · Workspace File Provenance：真实 Workspace writer 将 display label 与
         canonical kind/id 一起写入 IndexedDB；reserved-label / legacy / partial canonical
         的 archive collision routing canonical-first；export/import、mirror、reload 与
         script writeback 均走真实浏览器 probe。 */
      ['test_workspace_file_provenance.js'],
      /* P30-5 · Blog Conversation Scope（P30-4 契约实施）：
         `_execBlogReadOps(ops,scopeSrc)` 在 **request 创建时**捕获 request-origin scope 并写入
         `_blogReqReg[uid]`；`_brAllow`/`_brDeny` 只从 registry 继承（不看 click-time active 会话）；
         `_blogPendingReads` 带 scope、`_blogReadFeedback` 由 string[] 变为 scoped object[]（读侧兼容旧字符串）；
         `_getBlogReadInjection(scopeFilter)` 两队列各自 take/keep（MATCH TAKE / MISMATCH KEEP，
         不再清空）；自动续答仅在 origin 仍是活动会话时保留（canonical conversationId 比较）。 */
      ['test_blog_conversation_scope.js'],
      ['test_understanding_admission.js'],
      ['test_understanding_generation.js'],
      ['test_understanding_thread.js'],
      ['test_video_runtime_cdp.js'],
      ['test_boot_smoke.js'],
      ['test_error_ui_smoke.js'],
      ['test_setup_wizard_smoke.js'],
      ['test_diagnostics_smoke.js'],
      /* U4：更新卡片最小浏览器 smoke（真实 Chrome/Edge + 真实静态服务 + 真实
         状态文件；不下载、不安装、不打开系统浏览器，IB_UPDATE_DIR 指向临时目录） */
      ['test_update_card_smoke.js'],
      ['test_guide_shots.js'],
      ['test_guide_smoke.js'],
      /* P12：Image Router 浏览器最小冒烟（真实链路：Chat/Moments → Router → 现有执行器 → mock provider） */
      ['test_image_router_smoke.js'],
      /* P13：图片编辑浏览器冒烟（<ws_edit_image> → Resolver → Router → multipart /images/edits → A→B→C） */
      ['test_image_edit_smoke.js'],
      /* P15：Image Router 配置层浏览器冒烟（设置 UI → 保存 → 刷新 → 真实请求体用配置的 Key/模型 → 备用通道） */
      ['test_image_router_settings_smoke.js'],
      /* M1-A：桌面端 canonical chat authority 浏览器冒烟 —— 真实 services/home-node-service.js
         （随机端口 + 临时数据目录）+ 真实 mock 模型端点 + 真实 sendChatMessage，
         经 http://127.0.0.1:<port>/InternalBeyond.html 承载（产品的正常启动链）。
         断言：user/assistant 两条消息都落到 Home Node 的 canonical SQLite、
         revision 前进、镜像持有同一批 message id、Home Node 停掉后写入 fail closed
         且镜像不新增。刻意保持最小，不是全量浏览器套件。 */
      ['test_m1a_chat_authority_smoke.js', '--browser']
    ]
  }
];

/* ── Intentionally unregistered（台账 · R2-G2）──────────────────────────
   未登记的 test_*.js 可以**合法**存在（DEFER / RETIRE），因此本入口不追求
   "ACTUAL_ONLY = 0"。这里只登记**重要例外**与最终裁决；完整集合由机械审计生成
   （tmp/g2-registry-audit.js），不手抄 80+ 行清单 —— 手抄清单正是会腐烂的东西。

   R2-G2 对 G0 点名的 5 个候选的最终裁决（REGISTER / DEFER / RETIRE）：
     · test_context_snapshot.js             DEFER —— 由另一条并行工作线拥有；browser 直跑 RED
     · test_p11_2j_memory_admission.js      DEFER —— 静态锚点过期（createMoment 已变成
                                            (data,options)；core.js 的 DB_VER / store 数组
                                            已迁至 IBWebCoreDbSchema），修复属 schema-catalog
                                            阶段，不是 registry 解析问题
     · test_p11_3x_c_context_budget.js      DEFER —— 直跑 GREEN，但单测 235s；本入口没有
                                            slow / opt-in 机制，为一条测试发明新 runner 架构
                                            超出本轮范围
     · test_mobile_memory_read_boundary.js  DEFER（候选 RETIRE）—— service 直跑 RED
                                            （device-token 时代的 401 → suite error）；
                                            它是 MEMORY_RECALL_CONTRACT §17 的 **R2-A 历史**
                                            enforcement，mapping ≠ registry membership
     · test_p11_2i_integrity_closure.js     DEFER —— static 直跑 RED（多条旧 boundary 断言）
   ────────────────────────────────────────────────────────────────────── */

/* ── Registry integrity guard（R2-G2）──────────────────────────────────
   R1 每个 file-backed entry resolve 后必须 exists
   R2 重复的 executable path 必须**显式允许**（登记脚本 + 理由）
   R3 category 计数由 registry 机械计算 —— 不再有第二份手写 authority
   R4 REGISTERED_MISSING === 0
   刻意**不**要求 ACTUAL_ONLY === 0：未登记可以是合法 DEFER（见上面台账）。
   ────────────────────────────────────────────────────────────────────── */
const DUPLICATE_SCRIPTS_ALLOWED = {
  /* 同一脚本、两组不同 flag：默认离线 mock 一次 + corpus readiness 一次。
     两者语义不同，因此是**有意**重复登记，不是冗余登记。 */
  'test_middle_brain_calibration_live.js':
    'registered twice with different flag sets (default offline mock; --corpus=readiness run)'
};

const REGISTRY = [];
GROUPS.forEach(g => g.tests.forEach(t => {
  REGISTRY.push({ group: g.name, script: t[0], args: t.slice(1), path: scriptPath(t[0]) });
}));

function validateRegistry() {
  const problems = [];
  /* R1 / R4：file-backed entry 必须存在 */
  REGISTRY.forEach(e => {
    if (!fs.existsSync(e.path)) {
      problems.push('MISSING_FILE  ' + e.script + '  ->  '
        + path.relative(REPO_ROOT, e.path).replace(/\\/g, '/'));
    }
  });
  /* R2：重复 executable path 必须显式允许 */
  const byPath = new Map();
  REGISTRY.forEach(e => {
    if (!byPath.has(e.path)) byPath.set(e.path, []);
    byPath.get(e.path).push(e);
  });
  byPath.forEach((list, p) => {
    if (list.length < 2) return;
    const name = path.basename(p);
    if (!Object.prototype.hasOwnProperty.call(DUPLICATE_SCRIPTS_ALLOWED, name)) {
      problems.push('DUPLICATE_NOT_ALLOWED  ' + name + '  x' + list.length
        + '  (add it to DUPLICATE_SCRIPTS_ALLOWED with a reason, or de-duplicate the registry)');
    }
  });
  return problems;
}

const REGISTRY_PROBLEMS = validateRegistry();
if (REGISTRY_PROBLEMS.length) {
  console.error('REGISTRY INVALID —— 不会运行任何测试：');
  REGISTRY_PROBLEMS.forEach(p => console.error('  - ' + p));
  process.exit(3);
}
/* R3：category 计数与 registry 摘要由 registry 自身机械计算 */
const REGISTRY_CATEGORIES = GROUPS.map(g => g.name + ' ' + g.tests.length).join(' / ');
console.log('registry: ' + REGISTRY.length + ' entries · ' + new Set(REGISTRY.map(e => e.path)).size
  + ' unique scripts · ' + REGISTRY_CATEGORIES);

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
      killSignal: 'SIGKILL',
      /* ── P22-23 · 测试默认不自动 provision 桌面凭据 ──────────────────
         产品默认会在首次启动时生成并持久化一份桌面凭据（那正是 Economy
         首次使用链闭合的前提）。但这会**改变**一大堆既有测试的部署形态：
         它们真实 spawn services/home-node-service.js，而且刻意不设
         IB_HOME_NODE_TOKEN，验的就是"未配置凭据时桌面面是什么姿态"。
         那条部署路径依然合法（env 是 developer / headless override），
         因此那些测试应当**显式**说"我要那个形态"，而不是依赖一个会随产品
         演进的默认值。

         在这里统一关掉，比在每个测试文件里各写一遍更难漂移；需要验
         provisioning 的套件自己设 '1' 覆盖（子测试的显式 env 优先）。 */
      env: Object.assign({}, process.env, { IB_HOME_NODE_TOKEN_AUTOPROVISION: '0' })
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
