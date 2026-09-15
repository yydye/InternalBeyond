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
 * P2-07：入口不再遗漏仓库内的测试脚本。登记条目共 108 条 = 107 个 test_*.js
 * + scripts_check_html.js（HTML 结构检查）；分组：static 41 / service 18 / browser 51。
 * M1-A：新增 static 四条 —— test_lan_bridge_auth_contract.js（R19/§3.14 LAN 鉴权一致性）、
 *     test_chat_core_contract.js（Chat Message Contract）、
 *     test_chat_authority.js（权威/镜像/回退三态策略）、
 *     test_chat_migration.js（IndexedDB → Home Node 迁移端到端幂等）；
 *     service 两条 —— test_home_node_http.js（真实 HTTP 集成）、
 *     test_home_node_service.js（服务进程与 runner 注册契约）；
 *     browser 一条 —— test_m1a_chat_authority_smoke.js（真实 Home Node 进程 +
 *     真实 sendChatMessage，证明桌面单聊在切换权威之后仍然工作，且离线时 fail closed）。
 * 仓库当前有 99 个 test_*.js；并行会话在途的 test_context_snapshot.js 尚未登记
 * （不属于 P2/P3/P4/P5 改动面，登记与否由该会话决定）。
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
      ['test_welcome_canvas_payload.js']
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
