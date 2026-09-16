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
      ['test_p22_13_economy_approval_runtime.js']
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
                  change log 是**走到末尾**地读的（第一页满就继续）/
                  高级信息默认折叠、点一下展开 /
                  九个读路径全在声明里 / 两个写方法一次都没被调用 /
                  三个既有节点的 DOM 顺序逐字未变。
                  ★ 零子进程、零 socket、零浏览器。 */
      ['test_p22_18_economy_experience_ui_core.js'],
      ['test_p22_18_economy_experience_ui.js']
      /* P22-18 的浏览器视觉核对（test_p22_18_economy_experience_visual.js）
         与 P22-15/16/17 那三条一样**不在**默认套件里（它要开一个真实
         浏览器）：2 主题 × 4 宽度（含 320px）+ 截断/空/展开四种状态。
         跑法：node tests/test_p22_18_economy_experience_visual.js */
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
