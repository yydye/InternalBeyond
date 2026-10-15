'use strict';

/* IB interface localization.
   Only explicitly marked UI nodes are translated. User text, model output,
   role names, prompts and persisted business records are never traversed. */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && root.document) {
    root.IB = root.IB || {};
    root.IB.i18n = api;
    root.IBI18n = api;
    api.bootstrap();
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  'use strict';

  var VERSION = 1;
  var DEFAULT_LOCALE = 'zh-CN';
  var SUPPORTED_LOCALES = Object.freeze(['zh-CN', 'en-US']);
  var STORAGE_KEY = 'ib_locale_v1';

  var CATALOGS = {
    'zh-CN': {
      'nav.aria.main': '主导航', 'nav.aria.workspace': '工作区导航', 'nav.returnHome': '返回欢迎页',
      'nav.collapse': '收起导航', 'nav.expand': '展开导航',
      'nav.group.core': '核心', 'nav.group.create': '创作与连接', 'nav.group.work': '工作', 'nav.group.tools': '工具', 'nav.group.help': '帮助',
      'nav.home': '首页', 'nav.chat': '聊天', 'nav.profile': '个人资料', 'nav.memory': '记忆', 'nav.favorites': '收藏夹',
      'nav.blog': '日志', 'nav.moments': '朋友圈', 'nav.letters': '信件', 'nav.roleDm': '角色私信', 'nav.diary': '日记',
      'nav.active': '主动消息', 'nav.diy': 'DIY', 'nav.workMode': '工作模式', 'nav.apps': '应用', 'nav.economy': '经济',
      'nav.packaging': '打包中心', 'nav.settings': '设置', 'nav.api': 'API', 'nav.diagnostics': '系统诊断', 'nav.guide': '指南',
      'nav.bridge': 'Bridge', 'nav.more': '更多', 'nav.theme.toggle': '切换主题', 'nav.theme.toDark': '切换到深色主题', 'nav.theme.toLight': '切换到浅色主题',

      'settings.title': '设置', 'settings.description': '管理应用偏好、AI 连接、记忆策略、服务集成和本地数据。',
      'settings.nav.aria': '设置分类', 'settings.nav.heading': '设置分类',
      'settings.category.general': '通用', 'settings.category.appearance': '外观与体验', 'settings.category.ai': 'AI 与连接',
      'settings.category.memory': '记忆与认知', 'settings.category.services': '服务与集成', 'settings.category.data': '数据管理', 'settings.category.advanced': '高级',
      'settings.general.title': '通用', 'settings.general.description': '影响全局对话与后台活动的偏好。', 'settings.general.links': '相关页面',
      'settings.general.profile.title': '个人资料', 'settings.general.profile.description': '名称、简介与展示信息',
      'settings.general.active.title': '主动消息', 'settings.general.active.description': '按角色设置联系计划',
      'settings.general.diary.title': '日记偏好', 'settings.general.diary.description': '日记生成与角色设置',
      'settings.general.moments.title': '朋友圈偏好', 'settings.general.moments.description': '朋友圈生成与可见范围',
      'settings.language.label': '界面语言', 'settings.language.select': '选择界面语言', 'settings.language.help': '切换后立即生效，并保存在此设备。',
      'settings.language.coverage': '本阶段完整支持设置中心框架、静态设置控件与全局导航。已翻译 Home 固定面板、Chat 工具栏、Memory 列表工具栏与筛选、API 角色库和基础字段。动态设置卡、Memory 新建/编辑窗口、API 引导与高级角色选项、其他页面及部分日期提示仍按原文显示。用户内容与 AI 回复不会翻译。',
      'settings.language.saved': '语言偏好已保存在此设备。', 'settings.language.sessionOnly': '本次已切换，但本机存储不可写；重启后会恢复默认语言。',
      'settings.appearance.title': '外观与体验', 'settings.appearance.description': '主题切换与启动表现。',
      'settings.appearance.theme': '显示主题', 'settings.appearance.currentTheme': '当前主题：{theme}', 'settings.appearance.switchTheme': '切换主题',
      'settings.appearance.assets': '视觉素材', 'settings.appearance.assetsDescription': '角色立绘、Room 场景和背景图的文件规格由 DIY 说明页维护。', 'settings.appearance.openDiy': '查看 DIY 素材说明',
      'settings.ai.title': 'AI 与连接', 'settings.ai.description': '全局 AI 服务、模型路由与语音转写。',
      'settings.ai.rolesTitle': '角色 Provider 与凭据', 'settings.ai.rolesDescription': '角色模型、API Key、System Prompt、语音和角色级 Auto Memory 保留在现有角色配置中；凭据仍由 Credential Vault 管理。', 'settings.ai.openApi': '打开角色与 API 配置',
      'settings.memory.title': '记忆与认知', 'settings.memory.description': '控制记忆注入、对话上下文与角色认知策略。',
      'settings.memory.manageTitle': '记忆管理入口', 'settings.memory.manageDescription': 'Canonical Memory 的浏览、编辑与导入导出继续由 Memory 管理；Auto Memory 条目也在那里查看。',
      'settings.memory.openMemory': '打开 Memory', 'settings.memory.roleAutoMemory': '角色级 Auto Memory',
      'settings.services.title': '服务与集成', 'settings.services.description': '本地工具、MCP、Bridge 与支付授权。',
      'settings.services.bridgeTitle': 'Internal Bridge', 'settings.services.bridgeDescription': 'Bridge 控制面仍由现有面板提供；外部连接和高权限工具配置集中在此分类。', 'settings.services.openBridge': '打开 Bridge 面板',
      'settings.data.title': '数据管理', 'settings.data.description': '备份、聊天记录、存储状态与危险操作。',
      'settings.data.archiveTitle': '完整存档', 'settings.data.archiveDescription': '导入会合并现有存档内容；导出沿用当前完整存档格式与凭据处理规则。', 'settings.data.export': '导出存档', 'settings.data.import': '导入存档',
      'settings.advanced.title': '高级', 'settings.advanced.description': '诊断与开发期检查工具。', 'settings.advanced.diagnosticsTitle': '系统诊断',
      'settings.advanced.diagnosticsDescription': '检查本地环境、服务连接与应用状态。', 'settings.advanced.openDiagnostics': '打开系统诊断',

      'home.title': '继续上次的内容', 'home.description': '对话与活动集中于此。', 'home.openChat': '打开聊天', 'home.recent': '最近',
      'home.loading': '正在读取最近活动…', 'home.empty': '还没有最近活动。对话和活动会显示在这里。', 'home.someUnavailable': '部分最近活动暂时不可用。', 'home.unavailable': '暂时无法读取最近活动。',
      'home.type.conversation': '对话', 'home.type.reading': '共读', 'home.type.cinema': '观影', 'home.type.activity': '活动',
      'home.timeUnavailable': '时间不可用', 'home.justNow': '刚刚', 'home.minutesAgo': '{count} 分钟前', 'home.hoursAgo': '{count} 小时前', 'home.oneDayAgo': '1 天前', 'home.daysAgo': '{count} 天前',

      'chat.title': '聊天', 'chat.continue': '选择一段对话继续', 'chat.switchConversation': '切换对话', 'chat.chooseConversation': '选择对话',
      'chat.search': '搜索当前对话…', 'chat.openWorkspace': '打开工作区', 'chat.startVoiceCall': '开始语音通话',
      'chat.select': '选择', 'chat.selectTitle': '选择消息，可批量删除或生成记忆。', 'chat.members': '成员', 'chat.saveMemory': '保存记忆',
      'chat.messages': '对话消息', 'chat.emptyTitle': '选择一段对话', 'chat.emptyDescription': '从列表中选择角色、群聊或话题。',
      'chat.attach': '添加附件', 'chat.image': '图片', 'chat.file': '文件', 'chat.inputLabel': '输入消息', 'chat.inputPlaceholder': '输入消息…',
      'chat.recordVoice': '录制并发送语音消息', 'chat.stop': '停止生成', 'chat.send': '发送消息', 'chat.selectedCount': '已选 {count} 条',
      'chat.seal': '封档到此处', 'chat.cancel': '取消', 'chat.delete': '删除', 'chat.archivedNotice': '此对话已归档，不能继续发送消息。',

      'memory.title': '记忆', 'memory.description': '长期记忆会随时间淡化，也会在相关时重新浮现。管理你和 TA 之间的共同记忆。',
      'memory.descriptionLine1': '记忆库。一个有温度、会衰减、会浮现的长期记忆系统。', 'memory.descriptionLine2': '管理你和 TA 之间的共同记忆，让每一次对话都能延续过去的故事。',
      'memory.favorites': '收藏夹 · Favorites', 'memory.authorityChecking': '正在读取 Home Node 状态…',
      'memory.axisNegative': '消极', 'memory.axisPositive': '积极', 'memory.axisArousal': '唤醒', 'memory.axisCalm': '平静',
      'memory.legendDescription': 'Memory 星点来自 Home Node canonical records；Auto Memory 星点只表示独立角色档案。',
      'memory.legendImportance': '大小 = 重要性', 'memory.legendActivation': '明暗 = 活跃度', 'memory.legendPinned': '金色 = 置顶记忆', 'memory.legendAutoMemory': 'Auto Memory 是角色档案，不是 Memory 记录',
      'memory.total': '总计', 'memory.pinned': '置顶', 'memory.unresolved': '未解决', 'memory.resolved': '已解决',
      'memory.injectEstimate': '每次注入约 {chars} 字符（≈ {tokens} token）', 'memory.injectEstimatePrefix': '每次注入约 ', 'memory.injectEstimateMiddle': ' 字符（≈ ', 'memory.injectEstimateSuffix': ' token）', 'memory.injectLimit': '每次注入上限约 {chars} 字符',
      'memory.domainDistribution': '领域分布（颜色对应星点）', 'memory.autoMemory': 'Auto Memory · 角色档案', 'memory.autoMemoryArchived': '已归档 · 角色档案', 'memory.roleAutoMemory': '角色级 Auto Memory', 'memory.return': '返回',
      'memory.autoMemoryAuthority': '按 AI 角色分区的独立 IndexedDB 档案；不属于 Home Node canonical Memory，也不参与 canonical Recall。', 'memory.autoMemoryArchivedAuthority': '已归档 API 的独立角色档案；仍不属于 Home Node canonical Memory，也不参与 canonical Recall。',
      'memory.previous': '上一个', 'memory.next': '下一个', 'memory.archived': '已归档', 'memory.sectionTitle': '记忆', 'memory.sectionSubtitle': '星图索引',
      'memory.export': '导出记忆', 'memory.import': '导入记忆', 'memory.settings': '记忆与认知设置',
      'memory.cleanTitle': '扫描并清理 AI 生成的文学化自我感慨记忆', 'memory.clean': '清理无意义记忆', 'memory.new': '+ 新记忆',
      'memory.search': '搜索记忆…', 'memory.filterDomain': '全部领域', 'memory.filterStatus': '全部状态', 'memory.filterVisibility': '全部 AI 可见',
      'memory.sortCreated': '按时间', 'memory.sortScore': '按权重', 'memory.sortImportance': '按重要性',
      'memory.selectMessage': '选择此消息', 'memory.deselectMessage': '取消选择此消息',
      'memory.domain.emotion': '情感', 'memory.domain.daily': '日常', 'memory.domain.creative': '创作', 'memory.domain.thought': '思考',
      'memory.status.unresolved': '未解决', 'memory.status.resolved': '已解决',

      'api.title': '角色与 API 配置', 'api.subtitle': 'Provider 与角色配置', 'api.description': '配置角色 Provider、模型、凭据和角色提示词。API 是高频入口；全局偏好与数据管理在 Settings。',
      'api.roleLibrary': '角色库', 'api.unlimitedRoles': '（数量不限）', 'api.archived': '已归档', 'api.archivedTitle': '查看已归档的角色配置', 'api.archivedLibrary': '已归档的 API', 'api.archivedLimit': '（最多 20 个角色）', 'api.returnToLibrary': '返回', 'api.returnToLibraryTitle': '返回角色库', 'api.addRole': '+ 添加角色', 'api.newRole': '添加角色', 'api.editRole': '编辑角色',
      'api.basic': '基础设置', 'api.avatar': '头像', 'api.avatarHint1': '点击上传头像，将在 Chat 对话页面中显示。', 'api.avatarHint2': '推荐正方形图片，支持 JPG / PNG。', 'api.uploadAvatar': '上传头像', 'api.uploadBanner': '上传主页背景图', 'api.remove': '移除',
      'api.handle': '@账号', 'api.handleNote': '（社交网络主页显示名）', 'api.handlePlaceholder': '如 deepseek-v4-flash（留空自动生成）', 'api.handleHint': '显示在主页昵称下方；不能与其它角色重复。', 'api.bio': '简介', 'api.bioPlaceholder': '一句话介绍 TA（显示在主页）', 'api.signature': '个性签名', 'api.signaturePlaceholder': '显示在 @账号 下方的一行装饰',
      'api.publicProfile': '公开资料', 'api.nickname': '昵称', 'api.relationship': '关系', 'api.provider': '服务商', 'api.apiKey': 'API Key',
      'api.model': '模型', 'api.endpoint': '接口地址', 'api.systemPrompt': 'System Prompt（可选）', 'api.autoMemory': '启用 Auto Memory（AI 自主维护的角色档案）',
      'api.save': '保存', 'api.cancel': '取消', 'api.delete': '删除', 'api.tokenDashboard': 'Token 用量',

      'settings.control.startupHeading': '启动体验', 'settings.control.startupTitle': '启动动画',
      'settings.control.startupDescription': '首次启动和大版本更新后完整播放；普通启动可以跳过。开发模式默认关闭。',
      'settings.control.globalCognitionName': 'Middle Brain', 'settings.control.globalAstra': '（全局 · GPT-6 Astra）', 'settings.control.globalCognition': '全局智能层（独立于角色配置）',
      'settings.control.globalCognitionDescription': 'Middle Brain 是 IB 的全局层，不作为角色 Provider 出现。这里独立配置 Astra 端点；启用后供后续 Middle Brain 接入复用（本版仅保存配置与归一接口，不拦截角色请求）。',
      'settings.control.globalCognitionEnabled': '启用 Middle Brain', 'settings.control.globalCognitionSave': '保存 Middle Brain',
      'settings.control.cognitiveControl': 'Astra 认知控制', 'settings.control.reasoningEffort': '推理强度', 'settings.control.processing': '处理速度', 'settings.control.cognitiveControlHint': '思考深度只决定模型推理强度（自动跟随服务商原生行为，不额外发送参数）；处理速度只决定服务延迟策略。两者相互独立。',
      'settings.control.imageGeneration': '图像生成', 'settings.control.mode': '模式', 'settings.control.globalCognitionChoose': '由 Middle Brain 选择', 'settings.control.integrityGuard': '角色一致性守卫', 'settings.control.enableIntegrityGuard': '启用角色一致性守卫（检测明显 OOC）', 'settings.control.sensitivity': '灵敏度', 'settings.control.autoRewrite': '强 OOC 时自动定向重写（每条回复最多一次）', 'settings.control.verifyRewrite': '重写后复判（只观测，不会二次重写）', 'settings.control.integrityGuardHint': '保守优先：只修复明显违反角色证据的回复，不干预轻微风格差异；明确的上下文变化优先于静态人设。默认关闭。',
      'settings.control.imageRouterDescription': '所有图片请求统一经 Image Router。这里决定每条路由使用哪个图片 API 来源与模型；留空时跟随当前角色，绑定具体来源后，该路由与当前聊天角色解耦。图片来源使用现有角色 API 配置。',
      'settings.control.endpoint': '接口地址 (Endpoint)', 'settings.control.credentialBinding': '凭据绑定 (Credential Vault)', 'settings.control.networkRoute': '网络路径 (复用现有 API 配置)',
      'settings.control.imageRouter': 'Image Router', 'settings.control.globalImageRouter': '（全局 · 图片生成 / 编辑路由）', 'settings.control.imageRouterConfig': '路由配置', 'settings.control.saveImageRouter': '保存 Image Router',
      'settings.control.readScope': 'AI 读取范围', 'settings.control.readScopeDescription': '控制 AI 在写信、留言、聊天时能读取多少你的内容。范围越大，AI 越了解你，但也会消耗更多额度。',
      'settings.control.readChat': '读取聊天记录', 'settings.control.readGroupChat': '群聊读取聊天记录', 'settings.control.readPosts': '读取日志',
      'settings.control.voiceTranscription': '语音转写', 'settings.control.voiceTranscriptionDescription': '语音消息文字稿的来源。配置转写接口后，录音将交由该服务转写。',
      'settings.control.transcriptionEndpoint': '接口地址', 'settings.control.transcriptionKey': 'API Key', 'settings.control.transcriptionModel': '模型名',
      'settings.control.audioDirect': '音频直发：能听音频的模型直接接收原声',
      'settings.control.summary': '对话摘要', 'settings.control.enableSummary': '启用对话摘要', 'settings.control.recentKeep': '近期消息保留条数', 'settings.control.summaryApi': '摘要生成 API', 'settings.control.summaryWindow': '摘要回看窗口', 'settings.control.summaryManage': '摘要管理',
      'settings.control.presence': 'Presence', 'settings.control.enablePresence': '启用 Presence', 'settings.control.triggerInterval': '触发间隔', 'settings.control.enableSing': '启用 Sing',
      'settings.control.memorySettings': '记忆系统设置', 'settings.control.memorySettingsDescription': '控制记忆库在 API 调用时的注入行为。调高预算会增加 Token 消耗。', 'settings.control.memoryBudget': '注入字符上限', 'settings.control.memoryContentLength': '每条记忆内容截取长度', 'settings.control.memoryStreaming': '记忆生成启用流式传输（允许中途停止）',
      'settings.control.output': '输出与续写', 'settings.control.outputDescription': '回复触及模型输出上限时，可自动请求无缝续写。', 'settings.control.continuations': '自动续写轮数', 'settings.control.markdown': '聊天排版（Markdown）',
      'settings.control.dataProtection': '数据保险', 'settings.control.persistence': '持久化保护', 'settings.control.autoBackup': '每日自动备份', 'settings.control.emergencyMirror': '紧急镜像', 'settings.control.mirrorNow': '立即镜像', 'settings.control.folderSync': '本地文件夹同步', 'settings.control.dangerZone': '危险操作', 'settings.control.irreversible': '以下操作不可撤回，请谨慎使用。',
      'settings.control.allChats': '全部聊天记录', 'settings.control.clearChats': '清空聊天记录', 'settings.control.deleteChats': '删除聊天记录', 'settings.control.exportChats': '导出聊天记录',
      'settings.control.confirmDeleteSelected': '删除选中', 'settings.control.confirmExportSelected': '导出选中', 'settings.control.selectAll': '全选',
      'settings.control.clearKeys': '清除所有 API 密钥', 'settings.control.clearImages': '清除聊天图片', 'settings.control.clearMemory': '清空记忆库', 'settings.control.clearLetters': '清空信件', 'settings.control.clearSummaries': '清除对话摘要', 'settings.control.clearUploads': '清除上传文件', 'settings.control.clearTokenStats': '清空 Token 统计', 'settings.control.resetAll': '重置全站数据',
      'settings.control.transcriptionEndpointPlaceholder': '输入转写服务接口地址', 'settings.control.transcriptionKeyPlaceholder': '输入转写服务 API Key', 'settings.control.transcriptionModelPlaceholder': '输入转写模型名称', 'settings.control.transcriptionNote': '三项留空则维持浏览器内置识别。语音会附带本地计算的声学语气特征（语速 / 音量 / 停顿 / 语调），仅发给听不到原声的模型作参考，界面不显示；直发原声的模型自行听语气，不附加特征。转写失败时语音仍会发送并标注未能识别。若你的中转渠道不支持音频输入导致报错，可取消勾选「音频直发」。使用 Groq 等模型可能需要科学上网。',
      'settings.control.recent5': '最近 5 条（默认）', 'settings.control.recent10': '最近 10 条', 'settings.control.recent20': '最近 20 条', 'settings.control.recent30': '最近 30 条', 'settings.control.recent50': '最近 50 条', 'settings.control.all': '全部', 'settings.control.doNotRead': '不读取', 'settings.control.recentPosts1': '最近 1 篇', 'settings.control.recentPosts5': '最近 5 篇（默认）', 'settings.control.recentPosts10': '最近 10 篇',
      'settings.control.summaryDescription': '超出近期保留范围的旧消息会被压缩成摘要笔记，并按消息频率更新。', 'settings.control.default6': '（默认 6）',
      'settings.control.keep3': '3 条', 'settings.control.keep6': '6 条（默认）', 'settings.control.keep10': '10 条', 'settings.control.keep20': '20 条', 'settings.control.keep30': '30 条', 'settings.control.keep60': '60 条',
      'settings.control.summaryHint': '每 10 条新消息会触发一次摘要生成，消耗少量额外 Token。摘要作为后台参考注入。', 'settings.control.summaryApiNote': '（低成本模型可节省开销）',
      'settings.control.followChatApi': '跟随对话 API（默认）', 'settings.control.default60': '（默认 60 条）', 'settings.control.window60': '60 条（默认，摘要上限 600 字）', 'settings.control.window100': '100 条（摘要上限 800 字）',
      'settings.control.presenceInternal': '离开一段时间后再回来时，TA 会收到你离开的时长。', 'settings.control.presenceInfernal': '让 TA 注意到你离开了多久后才回来。', 'settings.control.default2h': '（默认 2 小时）',
      'settings.control.hours1': '1 小时', 'settings.control.hours2': '2 小时（默认）', 'settings.control.hours4': '4 小时', 'settings.control.hours8': '8 小时', 'settings.control.musicInternal': '播放音乐时，TA 会收到你正在听的曲目。', 'settings.control.musicInfernal': '让 TA 知道你正在听些什么。',
      'settings.control.default2000': '（默认 2000）', 'settings.control.budget1000': '1000 字符（节省）', 'settings.control.budget2000': '2000 字符（默认）', 'settings.control.budget4000': '4000 字符（丰富）', 'settings.control.budget6000': '6000 字符（完整）', 'settings.control.custom': '自定义…', 'settings.control.budgetCustomPlaceholder': '输入字符数（100–99999）',
      'settings.control.default200': '（默认 200 字符）', 'settings.control.content100': '100 字符（简要）', 'settings.control.content200': '200 字符（默认）', 'settings.control.content400': '400 字符（详细）', 'settings.control.content800': '800 字符（完整）', 'settings.control.contentCustomPlaceholder': '输入字符数（50–9999）', 'settings.control.memoryStreamingHint': '逐步生成，可中途停止；对应角色 API 也需开启流式传输。',
      'settings.control.continuationsNote': '（默认 3；0 = 关闭自动续写，只保留手动按钮）', 'settings.control.continue0': '0（仅手动）', 'settings.control.continue1': '1 轮', 'settings.control.continue3': '3 轮（默认）', 'settings.control.continue6': '6 轮', 'settings.control.continue10': '10 轮',
      'settings.control.markdownClean': '排版净化（符号显示为纯文字）', 'settings.control.markdownNone': '不处理（原样显示）', 'settings.control.markdownPartial': '部分渲染（代码块、行内代码和列表）', 'settings.control.markdownFull': '完整渲染（所有 Markdown 元素）', 'settings.control.markdownHint': '控制 AI 回复中 Markdown 标记的显示方式。排版净化会把标记转为纯文字；部分渲染只处理代码块、行内代码和列表；完整渲染会显示标题、粗体、斜体、引用和表格。流式回复也会同步渲染。只影响显示，不改变原文或 API 请求。',
      'settings.control.toggle': '开 / 关', 'settings.control.backupDescription': '自动备份：每天首次打开站点时静默导出完整 JSON 到下载文件夹。紧急镜像：核心数据每 10 分钟写入浏览器的备用存储，空库警告弹窗中可一键回灌。本地文件夹同步：绑定磁盘文件夹后，数据变动时自动写入备份文件；浏览器重启后需重新授权。',
      'settings.control.changeApiKey': '更换 API Key', 'settings.control.newApiKey': '新的 API Key', 'settings.control.pasteApiKey': '粘贴新的 API Key', 'settings.control.credentialStorageNote': 'API Key 保存在本地加密凭据存储中，不会写入角色配置。', 'settings.control.clearApiKey': '清除 API Key', 'settings.control.siteData': '全站数据：',
      'api.publicProfile': '公开资料', 'api.publicProfileNote': '（其他角色可以知道的部分）', 'api.publicIntro': '公开简介', 'api.publicIntroNote': '（1~3 句话，可留空）', 'api.publicIntroPlaceholder': '简要介绍角色的公开身份、特征或兴趣',
      'api.occupation': '身份 / 职业', 'api.occupationPlaceholder': '如：研究者 / 歌手 / 旅行者', 'api.publicTraits': '公开特征', 'api.publicTraitsNote': '（最多 5 个，用逗号分隔）', 'api.publicTraitsPlaceholder': '如：冷静、克制、好奇', 'api.interests': '兴趣', 'api.interestsNote': '（最多 5 个，用逗号分隔）', 'api.interestsPlaceholder': '如：生命科学、音乐、甜食',
      'api.joined': '加入时间', 'api.joinedHint': '首次保存后自动记录', 'api.relationshipNote': '（限 16 字符）', 'api.relationshipPlaceholder': '如：至亲之人、挚友、恋人…', 'api.customProvider': '自定义 / OpenAI Compatible', 'api.keyVaultPlaceholder': '由 Credential Vault 管理；此处不显示或保存密钥', 'api.modelPlaceholder': '例如 claude-sonnet-4-6', 'api.endpointNote': '（高级 · 一般不用改）', 'api.systemPromptPlaceholder': '设置 AI 的系统提示词…', 'api.clearDefaultPrompt': '点击文本框或此处可清空默认提示词，然后自行编辑。', 'api.enableImageGeneration': '启用图像生成', 'api.imageGenerationNote': '（仅限 OpenAI 兼容 / Gemini 生图模型）'
    },
    'en-US': {
      'nav.aria.main': 'Main navigation', 'nav.aria.workspace': 'Workspace navigation', 'nav.returnHome': 'Return to Welcome',
      'nav.collapse': 'Collapse navigation', 'nav.expand': 'Expand navigation',
      'nav.group.core': 'Core', 'nav.group.create': 'Create & Connect', 'nav.group.work': 'Work', 'nav.group.tools': 'Tools', 'nav.group.help': 'Help',
      'nav.home': 'Home', 'nav.chat': 'Chat', 'nav.profile': 'Profile', 'nav.memory': 'Memory', 'nav.favorites': 'Favorites',
      'nav.blog': 'Journal', 'nav.moments': 'Moments', 'nav.letters': 'Letters', 'nav.roleDm': 'Role DM', 'nav.diary': 'Diary',
      'nav.active': 'Active Messages', 'nav.diy': 'DIY', 'nav.workMode': 'Work Mode', 'nav.apps': 'Apps', 'nav.economy': 'Economy',
      'nav.packaging': 'Packaging', 'nav.settings': 'Settings', 'nav.api': 'API', 'nav.diagnostics': 'Diagnostics', 'nav.guide': 'Guide',
      'nav.bridge': 'Bridge', 'nav.more': 'More', 'nav.theme.toggle': 'Switch theme', 'nav.theme.toDark': 'Switch to dark theme', 'nav.theme.toLight': 'Switch to light theme',

      'settings.title': 'Settings', 'settings.description': 'Manage app preferences, AI connections, memory policies, integrations, and local data.',
      'settings.nav.aria': 'Settings categories', 'settings.nav.heading': 'Categories',
      'settings.category.general': 'General', 'settings.category.appearance': 'Appearance & Experience', 'settings.category.ai': 'AI & Connections',
      'settings.category.memory': 'Memory & Cognition', 'settings.category.services': 'Services & Integrations', 'settings.category.data': 'Data Management', 'settings.category.advanced': 'Advanced',
      'settings.general.title': 'General', 'settings.general.description': 'Preferences that shape conversations and background activity.', 'settings.general.links': 'Related pages',
      'settings.general.profile.title': 'Profile', 'settings.general.profile.description': 'Name, bio, and display details',
      'settings.general.active.title': 'Active Messages', 'settings.general.active.description': 'Set contact plans by character',
      'settings.general.diary.title': 'Diary preferences', 'settings.general.diary.description': 'Diary generation and character settings',
      'settings.general.moments.title': 'Moments preferences', 'settings.general.moments.description': 'Generation and visibility',
      'settings.language.label': 'Interface language', 'settings.language.select': 'Choose interface language', 'settings.language.help': 'Changes apply immediately and are saved on this device.',
      'settings.language.coverage': 'This phase fully localizes the Settings Center shell, static settings controls, and global navigation. It also translates the fixed Home panel, Chat toolbar, Memory list toolbar and filters, and the API character library and basic fields. Dynamic settings cards, the Memory create/edit dialog, API onboarding and advanced character options, other pages, and some date text keep their source language. User content and AI replies are never translated.',
      'settings.language.saved': 'Language preference saved on this device.', 'settings.language.sessionOnly': 'Changed for this session, but local storage is unavailable. The default language will return after restart.',
      'settings.appearance.title': 'Appearance & Experience', 'settings.appearance.description': 'Theme and startup behavior.',
      'settings.appearance.theme': 'Display theme', 'settings.appearance.currentTheme': 'Current theme: {theme}', 'settings.appearance.switchTheme': 'Switch theme',
      'settings.appearance.assets': 'Visual assets', 'settings.appearance.assetsDescription': 'DIY documents the file specs for character portraits, Room scenes, and backgrounds.', 'settings.appearance.openDiy': 'View DIY asset guide',
      'settings.ai.title': 'AI & Connections', 'settings.ai.description': 'Global AI services, model routing, and speech transcription.',
      'settings.ai.rolesTitle': 'Character providers and credentials', 'settings.ai.rolesDescription': 'Character models, API keys, system prompts, voice, and role-level Auto Memory stay in the existing character editor. Credentials remain managed by Credential Vault.', 'settings.ai.openApi': 'Open character and API settings',
      'settings.memory.title': 'Memory & Cognition', 'settings.memory.description': 'Control memory injection, conversation context, and character cognition policies.',
      'settings.memory.manageTitle': 'Memory management', 'settings.memory.manageDescription': 'Canonical Memory browsing, editing, and import/export remain in Memory. Auto Memory entries are managed there too.',
      'settings.memory.openMemory': 'Open Memory', 'settings.memory.roleAutoMemory': 'Role-level Auto Memory',
      'settings.services.title': 'Services & Integrations', 'settings.services.description': 'Local tools, MCP, Bridge, and payment authorization.',
      'settings.services.bridgeTitle': 'Internal Bridge', 'settings.services.bridgeDescription': 'The existing Bridge panel remains the control surface. External connections and high-privilege tools are grouped here.', 'settings.services.openBridge': 'Open Bridge panel',
      'settings.data.title': 'Data Management', 'settings.data.description': 'Backups, chat records, storage, and destructive actions.',
      'settings.data.archiveTitle': 'Full archive', 'settings.data.archiveDescription': 'Import merges archive contents. Export keeps the existing archive format and credential handling.', 'settings.data.export': 'Export archive', 'settings.data.import': 'Import archive',
      'settings.advanced.title': 'Advanced', 'settings.advanced.description': 'Diagnostics and development checks.', 'settings.advanced.diagnosticsTitle': 'System diagnostics',
      'settings.advanced.diagnosticsDescription': 'Check the local environment, service connections, and app state.', 'settings.advanced.openDiagnostics': 'Open diagnostics',

      'home.title': 'Continue where you left off', 'home.description': 'Conversations and activity, in one place.', 'home.openChat': 'Open Chat', 'home.recent': 'Recent',
      'home.loading': 'Loading recent activity…', 'home.empty': 'No recent activity yet. Conversations and activity will appear here.', 'home.someUnavailable': 'Some recent activity is temporarily unavailable.', 'home.unavailable': 'Recent activity is temporarily unavailable.',
      'home.type.conversation': 'Conversation', 'home.type.reading': 'Reading', 'home.type.cinema': 'Cinema', 'home.type.activity': 'Activity',
      'home.timeUnavailable': 'Time unavailable', 'home.justNow': 'Just now', 'home.minutesAgo': '{count} min ago', 'home.hoursAgo': '{count} hr ago', 'home.oneDayAgo': '1 day ago', 'home.daysAgo': '{count} days ago',

      'chat.title': 'Chat', 'chat.continue': 'Choose a conversation to continue', 'chat.switchConversation': 'Switch conversation', 'chat.chooseConversation': 'Choose a conversation',
      'chat.search': 'Search this conversation…', 'chat.openWorkspace': 'Open Workspace', 'chat.startVoiceCall': 'Start voice call',
      'chat.select': 'Select', 'chat.selectTitle': 'Select messages to delete in bulk or create a memory.', 'chat.members': 'Members', 'chat.saveMemory': 'Save Memory',
      'chat.messages': 'Conversation messages', 'chat.emptyTitle': 'Choose a conversation', 'chat.emptyDescription': 'Choose a character, group chat, or thread from the list.',
      'chat.attach': 'Add attachment', 'chat.image': 'Image', 'chat.file': 'File', 'chat.inputLabel': 'Message', 'chat.inputPlaceholder': 'Write a message…',
      'chat.recordVoice': 'Record and send a voice message', 'chat.stop': 'Stop generation', 'chat.send': 'Send message', 'chat.selectedCount': '{count} selected',
      'chat.seal': 'Archive through here', 'chat.cancel': 'Cancel', 'chat.delete': 'Delete', 'chat.archivedNotice': 'This conversation is archived. Messages can no longer be sent.',

      'memory.title': 'Memory', 'memory.description': 'Long-term memories fade over time and surface again when relevant. Manage shared memories between you and your characters.',
      'memory.descriptionLine1': 'A warm long-term memory system that fades over time and surfaces when relevant.', 'memory.descriptionLine2': 'Manage shared memories with your characters so conversations can continue their stories.',
      'memory.favorites': 'Favorites', 'memory.authorityChecking': 'Checking Home Node status…',
      'memory.axisNegative': 'Negative', 'memory.axisPositive': 'Positive', 'memory.axisArousal': 'Arousal', 'memory.axisCalm': 'Calm',
      'memory.legendDescription': 'Memory stars come from Home Node canonical records; Auto Memory stars represent separate character profiles.',
      'memory.legendImportance': 'Size = importance', 'memory.legendActivation': 'Brightness = activity', 'memory.legendPinned': 'Gold = pinned memory', 'memory.legendAutoMemory': 'Auto Memory is a character profile, not a Memory record',
      'memory.total': 'Total', 'memory.pinned': 'Pinned', 'memory.unresolved': 'Unresolved', 'memory.resolved': 'Resolved',
      'memory.injectEstimate': 'About {chars} characters per injection (≈ {tokens} tokens)', 'memory.injectEstimatePrefix': 'About ', 'memory.injectEstimateMiddle': ' characters per injection (≈ ', 'memory.injectEstimateSuffix': ' tokens)', 'memory.injectLimit': 'Injection limit: about {chars} characters',
      'memory.domainDistribution': 'Domain distribution (colors match the stars)', 'memory.autoMemory': 'Auto Memory · Character Profiles', 'memory.autoMemoryArchived': 'Archived · Role profile', 'memory.roleAutoMemory': 'Role-level Auto Memory', 'memory.return': 'Return',
      'memory.autoMemoryAuthority': 'Separate IndexedDB profiles by AI character. They are outside Home Node canonical Memory and canonical Recall.', 'memory.autoMemoryArchivedAuthority': 'Separate profiles from archived API configs. They remain outside Home Node canonical Memory and canonical Recall.',
      'memory.previous': 'Previous', 'memory.next': 'Next', 'memory.archived': 'Archived', 'memory.sectionTitle': 'Memories', 'memory.sectionSubtitle': 'The Constellation Index',
      'memory.export': 'Export memories', 'memory.import': 'Import memories', 'memory.settings': 'Memory & Cognition settings',
      'memory.cleanTitle': 'Scan and remove AI-generated literary self-reflections', 'memory.clean': 'Clean low-value memories', 'memory.new': '+ New memory',
      'memory.search': 'Search memories…', 'memory.filterDomain': 'All domains', 'memory.filterStatus': 'All statuses', 'memory.filterVisibility': 'Visible to all AIs',
      'memory.sortCreated': 'By date', 'memory.sortScore': 'By score', 'memory.sortImportance': 'By importance',
      'memory.selectMessage': 'Select this message', 'memory.deselectMessage': 'Deselect this message',
      'memory.domain.emotion': 'Emotion', 'memory.domain.daily': 'Daily life', 'memory.domain.creative': 'Creative work', 'memory.domain.thought': 'Thoughts',
      'memory.status.unresolved': 'Unresolved', 'memory.status.resolved': 'Resolved',

      'api.title': 'Characters & API', 'api.subtitle': 'Providers and character settings', 'api.description': 'Configure character providers, models, credentials, and prompts. API remains a quick-access page; global preferences and data tools are in Settings.',
      'api.roleLibrary': 'Character library', 'api.unlimitedRoles': '(unlimited)', 'api.archived': 'Archived', 'api.archivedTitle': 'View archived character configs', 'api.archivedLibrary': 'Archived APIs', 'api.archivedLimit': '(up to 20 characters)', 'api.returnToLibrary': 'Return', 'api.returnToLibraryTitle': 'Return to character library', 'api.addRole': '+ Add character', 'api.newRole': 'Add character', 'api.editRole': 'Edit character',
      'api.basic': 'Basics', 'api.avatar': 'Avatar', 'api.avatarHint1': 'Upload an avatar to show it in Chat.', 'api.avatarHint2': 'Square JPG or PNG images are recommended.', 'api.uploadAvatar': 'Upload avatar', 'api.uploadBanner': 'Upload profile background', 'api.remove': 'Remove',
      'api.handle': '@handle', 'api.handleNote': '(Name shown on the social profile)', 'api.handlePlaceholder': 'e.g. deepseek-v4-flash (leave blank to generate)', 'api.handleHint': 'Shown below the profile name; must be unique.', 'api.bio': 'Bio', 'api.bioPlaceholder': 'A one-line introduction (shown on the profile)', 'api.signature': 'Signature', 'api.signaturePlaceholder': 'A decorative line below the @handle',
      'api.publicProfile': 'Public profile', 'api.nickname': 'Name', 'api.relationship': 'Relationship', 'api.provider': 'Provider', 'api.apiKey': 'API Key',
      'api.model': 'Model', 'api.endpoint': 'Endpoint', 'api.systemPrompt': 'System prompt (optional)', 'api.autoMemory': 'Enable Auto Memory (AI-maintained character profile)',
      'api.save': 'Save', 'api.cancel': 'Cancel', 'api.delete': 'Delete', 'api.tokenDashboard': 'Token usage',

      'settings.control.startupHeading': 'Startup experience', 'settings.control.startupTitle': 'Startup animation',
      'settings.control.startupDescription': 'Play fully on first launch and major updates. Regular launches can be skipped. Disabled by default in development.',
      'settings.control.globalCognitionName': 'Middle Brain', 'settings.control.globalAstra': '(Global · GPT-6 Astra)', 'settings.control.globalCognition': 'Global intelligence layer (separate from character settings)',
      'settings.control.globalCognitionDescription': 'Middle Brain is a global IB layer, separate from character providers. Configure its Astra endpoint here. The current version stores and normalizes configuration without intercepting character requests.',
      'settings.control.globalCognitionEnabled': 'Enable Middle Brain', 'settings.control.globalCognitionSave': 'Save Middle Brain',
      'settings.control.cognitiveControl': 'Astra Cognitive Control', 'settings.control.reasoningEffort': 'Reasoning effort', 'settings.control.processing': 'Processing speed', 'settings.control.cognitiveControlHint': 'Reasoning effort controls model reasoning strength (Auto follows the provider without sending extra parameters). Processing controls service latency. These settings are independent.',
      'settings.control.imageGeneration': 'Image Generation', 'settings.control.mode': 'Mode', 'settings.control.globalCognitionChoose': 'Let Middle Brain choose', 'settings.control.integrityGuard': 'Character Integrity Guard', 'settings.control.enableIntegrityGuard': 'Enable the character integrity guard (detect clear OOC)', 'settings.control.sensitivity': 'Sensitivity', 'settings.control.autoRewrite': 'Automatically rewrite clear OOC replies (at most once per reply)', 'settings.control.verifyRewrite': 'Recheck after rewrite (observe only; no second rewrite)', 'settings.control.integrityGuardHint': 'Prefer conservative corrections: fix only clear conflicts with character evidence, not minor style differences. Explicit context changes take precedence over static profiles. Off by default.',
      'settings.control.imageRouterDescription': 'All image requests use Image Router. Choose the image API source and model for each route. Leave a route unbound to follow the current character, or bind a source to decouple it from the current chat. Image sources reuse existing character API configurations.',
      'settings.control.endpoint': 'Endpoint', 'settings.control.credentialBinding': 'Credential binding (Credential Vault)', 'settings.control.networkRoute': 'Network route (reuse an existing API config)',
      'settings.control.imageRouter': 'Image Router', 'settings.control.globalImageRouter': '(Global · image generation / editing routes)', 'settings.control.imageRouterConfig': 'Routing settings', 'settings.control.saveImageRouter': 'Save Image Router',
      'settings.control.readScope': 'AI access range', 'settings.control.readScopeDescription': 'Control how much of your content AI can read for letters, notes, and chat. A wider range uses more tokens.',
      'settings.control.readChat': 'Chat history access', 'settings.control.readGroupChat': 'Group chat history access', 'settings.control.readPosts': 'Journal access',
      'settings.control.voiceTranscription': 'Speech transcription', 'settings.control.voiceTranscriptionDescription': 'Choose the source for voice-message transcripts. Configure a transcription endpoint to process recordings.',
      'settings.control.transcriptionEndpoint': 'Endpoint', 'settings.control.transcriptionKey': 'API Key', 'settings.control.transcriptionModel': 'Model',
      'settings.control.audioDirect': 'Send audio directly to models that can listen to it',
      'settings.control.summary': 'Conversation summaries', 'settings.control.enableSummary': 'Enable conversation summaries', 'settings.control.recentKeep': 'Recent messages to keep', 'settings.control.summaryApi': 'Summary generation API', 'settings.control.summaryWindow': 'Summary review window', 'settings.control.summaryManage': 'Manage summaries',
      'settings.control.presence': 'Presence', 'settings.control.enablePresence': 'Enable Presence', 'settings.control.triggerInterval': 'Trigger interval', 'settings.control.enableSing': 'Share current music',
      'settings.control.memorySettings': 'Memory settings', 'settings.control.memorySettingsDescription': 'Control memory injection during API calls. A larger budget uses more tokens.', 'settings.control.memoryBudget': 'Injection character limit', 'settings.control.memoryContentLength': 'Maximum text per memory', 'settings.control.memoryStreaming': 'Stream memory generation (can be stopped)',
      'settings.control.output': 'Output and continuation', 'settings.control.outputDescription': 'When a reply hits the model output limit, automatically request a seamless continuation.', 'settings.control.continuations': 'Automatic continuation rounds', 'settings.control.markdown': 'Chat formatting (Markdown)',
      'settings.control.dataProtection': 'Data protection', 'settings.control.persistence': 'Persistent storage', 'settings.control.autoBackup': 'Daily automatic backup', 'settings.control.emergencyMirror': 'Emergency mirror', 'settings.control.mirrorNow': 'Create mirror now', 'settings.control.folderSync': 'Local folder sync', 'settings.control.dangerZone': 'Destructive actions', 'settings.control.irreversible': 'These actions cannot be undone. Proceed carefully.',
      'settings.control.allChats': 'All chat records', 'settings.control.clearChats': 'Clear chat history', 'settings.control.deleteChats': 'Delete chat records', 'settings.control.exportChats': 'Export chat records',
      'settings.control.confirmDeleteSelected': 'Delete selected', 'settings.control.confirmExportSelected': 'Export selected', 'settings.control.selectAll': 'Select all',
      'settings.control.clearKeys': 'Clear all API keys', 'settings.control.clearImages': 'Clear chat images', 'settings.control.clearMemory': 'Clear Memory', 'settings.control.clearLetters': 'Clear letters', 'settings.control.clearSummaries': 'Clear summaries', 'settings.control.clearUploads': 'Clear uploaded files', 'settings.control.clearTokenStats': 'Clear token usage', 'settings.control.resetAll': 'Reset all app data',
      'settings.control.transcriptionEndpointPlaceholder': 'Transcription service endpoint', 'settings.control.transcriptionKeyPlaceholder': 'Transcription service API key', 'settings.control.transcriptionModelPlaceholder': 'Transcription model name', 'settings.control.transcriptionNote': 'Leave all three fields blank to use browser recognition. Locally calculated acoustic cues (speech rate, volume, pauses, and pitch) are sent only to models that cannot receive audio; they are not shown in the UI. Models receiving original audio hear those cues directly. If transcription fails, the voice is still sent with an unrecognized notice. If your relay does not accept audio input, turn off direct audio. Some services may require network access.',
      'settings.control.recent5': 'Last 5 (default)', 'settings.control.recent10': 'Last 10', 'settings.control.recent20': 'Last 20', 'settings.control.recent30': 'Last 30', 'settings.control.recent50': 'Last 50', 'settings.control.all': 'All', 'settings.control.doNotRead': 'Do not read', 'settings.control.recentPosts1': 'Last 1 post', 'settings.control.recentPosts5': 'Last 5 posts (default)', 'settings.control.recentPosts10': 'Last 10 posts',
      'settings.control.summaryDescription': 'Older messages outside the recent window are compressed into notes and updated as new messages arrive.', 'settings.control.default6': '(default: 6)',
      'settings.control.keep3': '3 messages', 'settings.control.keep6': '6 messages (default)', 'settings.control.keep10': '10 messages', 'settings.control.keep20': '20 messages', 'settings.control.keep30': '30 messages', 'settings.control.keep60': '60 messages',
      'settings.control.summaryHint': 'A summary is generated every 10 new messages and uses a small amount of extra tokens.', 'settings.control.summaryApiNote': '(a lower-cost model can reduce usage)',
      'settings.control.followChatApi': 'Follow chat API (default)', 'settings.control.default60': '(default: 60 messages)', 'settings.control.window60': '60 messages (default, up to 600 characters)', 'settings.control.window100': '100 messages (up to 800 characters)',
      'settings.control.presenceInternal': 'When you return after some time away, TA receives how long you were gone.', 'settings.control.presenceInfernal': 'Let TA notice how long you were away before you return.', 'settings.control.default2h': '(default: 2 hours)',
      'settings.control.hours1': '1 hour', 'settings.control.hours2': '2 hours (default)', 'settings.control.hours4': '4 hours', 'settings.control.hours8': '8 hours', 'settings.control.musicInternal': 'When music is playing, TA receives the track you are listening to.', 'settings.control.musicInfernal': 'Let TA know what you are listening to.',
      'settings.control.default2000': '(default: 2,000)', 'settings.control.budget1000': '1,000 characters (compact)', 'settings.control.budget2000': '2,000 characters (default)', 'settings.control.budget4000': '4,000 characters (expanded)', 'settings.control.budget6000': '6,000 characters (full)', 'settings.control.custom': 'Custom…', 'settings.control.budgetCustomPlaceholder': 'Character count (100–99,999)',
      'settings.control.default200': '(default: 200 characters)', 'settings.control.content100': '100 characters (brief)', 'settings.control.content200': '200 characters (default)', 'settings.control.content400': '400 characters (detailed)', 'settings.control.content800': '800 characters (full)', 'settings.control.contentCustomPlaceholder': 'Character count (50–9,999)', 'settings.control.memoryStreamingHint': 'Streams generation and can be stopped. Streaming must also be enabled for the selected character API.',
      'settings.control.continuationsNote': '(default: 3; 0 disables automatic continuation and keeps the manual button)', 'settings.control.continue0': '0 (manual only)', 'settings.control.continue1': '1 round', 'settings.control.continue3': '3 rounds (default)', 'settings.control.continue6': '6 rounds', 'settings.control.continue10': '10 rounds',
      'settings.control.markdownClean': 'Clean typography (show symbols as plain text)', 'settings.control.markdownNone': 'No processing (show as-is)', 'settings.control.markdownPartial': 'Partial rendering (code blocks, inline code, and lists)', 'settings.control.markdownFull': 'Full Markdown rendering', 'settings.control.markdownHint': 'Controls how Markdown in AI replies is displayed. Clean mode turns markers into plain text; partial mode renders code blocks, inline code, and lists; full mode renders headings, bold, italics, quotes, and tables. Streaming replies also update as they arrive. This only changes display, not source text or API requests.',
      'settings.control.toggle': 'On / Off', 'settings.control.backupDescription': 'Automatic backup silently exports a full JSON archive to Downloads on the first launch each day. Emergency mirrors copy core data to browser storage every 10 minutes and can be restored from the empty-database warning. Local folder sync writes backups when data changes; browser permission must be renewed after restarting.',
      'settings.control.changeApiKey': 'Change API Key', 'settings.control.newApiKey': 'New API Key', 'settings.control.pasteApiKey': 'Paste a new API Key', 'settings.control.credentialStorageNote': 'API Keys are stored in local encrypted credential storage, not in character configuration.', 'settings.control.clearApiKey': 'Clear API Key', 'settings.control.siteData': 'All app data:',
      'api.publicProfile': 'Public profile', 'api.publicProfileNote': '(information other characters may know)', 'api.publicIntro': 'Public introduction', 'api.publicIntroNote': '(1–3 sentences; optional)', 'api.publicIntroPlaceholder': 'Briefly describe the character’s public identity, traits, or interests',
      'api.occupation': 'Identity / occupation', 'api.occupationPlaceholder': 'e.g. researcher / singer / traveler', 'api.publicTraits': 'Public traits', 'api.publicTraitsNote': '(up to 5, comma-separated)', 'api.publicTraitsPlaceholder': 'e.g. calm, reserved, curious', 'api.interests': 'Interests', 'api.interestsNote': '(up to 5, comma-separated)', 'api.interestsPlaceholder': 'e.g. life sciences, music, sweets',
      'api.joined': 'Joined', 'api.joinedHint': 'Recorded automatically after first save', 'api.relationshipNote': '(up to 16 characters)', 'api.relationshipPlaceholder': 'e.g. family, close friend, partner…', 'api.customProvider': 'Custom / OpenAI Compatible', 'api.keyVaultPlaceholder': 'Managed by Credential Vault; the key is not displayed or saved here', 'api.modelPlaceholder': 'e.g. claude-sonnet-4-6', 'api.endpointNote': '(advanced; usually does not need changes)', 'api.systemPromptPlaceholder': 'Set the AI system prompt…', 'api.clearDefaultPrompt': 'Click the text area or this line to clear the default prompt and edit it.', 'api.enableImageGeneration': 'Enable image generation', 'api.imageGenerationNote': '(OpenAI-compatible / Gemini image models only)'
    }
  };

  var activeLocale = DEFAULT_LOCALE;
  var observer = null;

  function normalizeLocale(value) {
    var text = String(value || '').trim().toLowerCase();
    if (text === 'en' || text.indexOf('en-') === 0) return 'en-US';
    if (text === 'zh' || text.indexOf('zh-') === 0) return 'zh-CN';
    return DEFAULT_LOCALE;
  }
  function readSavedLocale() {
    try { return normalizeLocale(root && root.localStorage && root.localStorage.getItem(STORAGE_KEY)); }
    catch (_) { return DEFAULT_LOCALE; }
  }
  function t(key, vars) {
    var localeTable = CATALOGS[activeLocale] || CATALOGS[DEFAULT_LOCALE];
    var fallbackTable = CATALOGS[DEFAULT_LOCALE];
    var value = Object.prototype.hasOwnProperty.call(localeTable, key) ? localeTable[key] : fallbackTable[key];
    if (value == null) return String(key);
    return String(value).replace(/\{([a-zA-Z0-9_]+)\}/g, function (match, name) {
      return vars && Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match;
    });
  }
  function setDirectText(el, value) {
    if (!el || !el.childNodes) return;
    var direct = Array.prototype.filter.call(el.childNodes, function (node) {
      return node.nodeType === 3 && String(node.nodeValue || '').trim();
    });
    if (direct.length) direct[0].nodeValue = value;
    else el.insertBefore(el.ownerDocument.createTextNode(value), el.firstChild);
  }
  function translateElement(el) {
    if (!el || el.nodeType !== 1 || (el.closest && el.closest('[data-i18n-skip]'))) return;
    var key = el.getAttribute('data-i18n');
    if (key) setDirectText(el, t(key));
    [['data-i18n-title', 'title'], ['data-i18n-aria-label', 'aria-label'], ['data-i18n-placeholder', 'placeholder']]
      .forEach(function (pair) {
        var attrKey = el.getAttribute(pair[0]);
        if (attrKey) el.setAttribute(pair[1], t(attrKey));
      });
  }
  function refreshThemeLabel(doc) {
    var button = doc && doc.getElementById('theme-toggle');
    if (!button) return;
    button.title = t('nav.theme.toggle');
    button.setAttribute('aria-label', t(doc.body && doc.body.classList.contains('theme-infernal') ? 'nav.theme.toLight' : 'nav.theme.toDark'));
  }
  function apply(scope) {
    var doc = root && root.document;
    if (!doc) return;
    var target = scope || doc;
    if (target.nodeType === 1) translateElement(target);
    if (target.querySelectorAll) {
      target.querySelectorAll('[data-i18n],[data-i18n-title],[data-i18n-aria-label],[data-i18n-placeholder]')
        .forEach(translateElement);
    }
    doc.querySelectorAll('[data-i18n-locale-picker]').forEach(function (select) { select.value = activeLocale; });
    refreshThemeLabel(doc);
  }
  function setLocale(locale) {
    activeLocale = normalizeLocale(locale);
    var doc = root && root.document;
    if (doc && doc.documentElement) {
      doc.documentElement.lang = activeLocale;
      doc.documentElement.setAttribute('data-locale', activeLocale);
    }
    var persisted = false;
    try {
      if (root && root.localStorage) {
        root.localStorage.setItem(STORAGE_KEY, activeLocale);
        persisted = root.localStorage.getItem(STORAGE_KEY) === activeLocale;
      }
    } catch (_) { persisted = false; }
    apply(doc);
    var status = doc && doc.getElementById('settings-language-status');
    if (status) status.textContent = t(persisted ? 'settings.language.saved' : 'settings.language.sessionOnly');
    if (doc && typeof root.CustomEvent === 'function') {
      doc.dispatchEvent(new root.CustomEvent('ib:locale-changed', { bubbles: true, detail: { locale: activeLocale, persisted: persisted } }));
    }
    return { locale: activeLocale, persisted: persisted };
  }
  function observeDynamicUi(doc) {
    var win = root;
    if (!doc || !doc.body || !win || typeof win.MutationObserver !== 'function' || observer) return;
    observer = new win.MutationObserver(function (records) {
      records.forEach(function (record) {
        Array.prototype.forEach.call(record.addedNodes || [], function (node) {
          if (node.nodeType === 1) apply(node);
        });
      });
    });
    observer.observe(doc.body, { childList: true, subtree: true });
  }
  function bootstrap() {
    var doc = root && root.document;
    if (!doc) return activeLocale;
    activeLocale = readSavedLocale();
    if (doc.documentElement) {
      doc.documentElement.lang = activeLocale;
      doc.documentElement.setAttribute('data-locale', activeLocale);
    }
    function ready() {
      apply(doc);
      observeDynamicUi(doc);
      if (typeof root.CustomEvent === 'function') {
        doc.dispatchEvent(new root.CustomEvent('ib:locale-changed', { bubbles: true, detail: { locale: activeLocale, persisted: true, initial: true } }));
      }
    }
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', ready, { once: true });
    else ready();
    return activeLocale;
  }

  return {
    VERSION: VERSION,
    DEFAULT_LOCALE: DEFAULT_LOCALE,
    SUPPORTED_LOCALES: SUPPORTED_LOCALES,
    STORAGE_KEY: STORAGE_KEY,
    CATALOGS: CATALOGS,
    get locale() { return activeLocale; },
    normalizeLocale: normalizeLocale,
    t: t,
    apply: apply,
    setLocale: setLocale,
    bootstrap: bootstrap
  };
});
