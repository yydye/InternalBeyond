/* ====================================================================
   Astra Readiness Phase 1 · 确定性观测语料（Astra Readiness corpus）
   --------------------------------------------------------------------
   本文件**不是生产代码**：不被 InternalBeyond.html 加载，也不被 assets/js/**
   或 services/** 任何生产文件引用。它只提供"喂给真实执行路径的确定性输入"。

   ── 为什么另建一份语料，而不是复用 middle-brain-calibration-cases.js ─────
   旧的 122 条语料是按 **Character Integrity 判定类别** 组织的，而且每条都带
   一份 authored 的 `observedJudge`（人工记录的 Judge 输出）。它对 Layer A 的
   指标契约校准是正确的，但对"真实模型观测"有一个致命的形状问题：
     · 它的 `observedJudge` 是**人工写死的**，真实模型的答案无处安放；
     · 实测它的 history 字符数 min=0 / max=55，而 Gate 的 dlgCharsLow=600 ——
       也就是这批语料**全部落在 dialogue 权重的最低档**，根本压不动 Gate 的
       对话项，无法用来观测 600/3500 这两个边界是否对齐。
   所以本语料按 **观测类别 A–U**（Astra Readiness Phase 1 §3）组织，并且：
     ① 每条都可以直接喂进真实执行路径（角色 / 历史 / 当前消息 / 候选 / 上下文）；
     ② **不携带任何 authored 观测**：`observed` 恒为 null，只有真实运行才填；
     ③ `expectation` 是**契约/人工期望**，与模型结果结构上分离（§3 硬要求）；
     ④ 长历史 / 超长当前消息 / 重复文本 / 连排助理行等形状按需构造，
        让 dialogue 字符数真正覆盖 600/3500 两侧。

   ── 期望（expectation）的两种形态（不要混用）─────────────────────────
     kind:'judgement' —— 人工判定：这条候选是不是 OOC、该不该重写。
                         用于"有明显的对错"的样本（Q 清晰通过 / R 清晰失败 / T 需重写）。
     kind:'contract'  —— 契约约束：**不**断言模型该判什么，只断言系统**不得**
                         违反的不变量（例如"证据不可用的维度不得据此判 fail"）。
                         这类样本的模型结果对错由契约判定，而不是由人工标签判定。
   为什么必须区分：把"证据不足"这类样本硬写成 ooc:false，就等于用人工标签
   冒充"模型也应该判 pass"，而那恰恰是本阶段要观测的东西。宁可为 null。

   ── 角色身份不复制 ──────────────────────────────────────────────────
   5 个合成角色（companion / builder / cold / technical / sparse）直接复用旧语料的
   PROFILES —— 它们是同一批**合成**身份，不是生产角色表，也不含任何真实用户数据。
   ==================================================================== */
'use strict';

const path = require('path');

const CAL_CASES = require('./middle-brain-calibration-cases.js');
const PROFILES = CAL_CASES.PROFILES;

/* ── 观测类别 A–U（Astra Readiness Phase 1 §3 的逐条落地）───────────────── */
const CLASSES = [
  ['A', '正常在角色回复'],
  ['B', '明显人格 OOC'],
  ['C', '细微说话风格漂移'],
  ['D', '关系状态不一致'],
  ['E', '情感连续性断裂'],
  ['F', '知识边界越界'],
  ['G', '证据不足'],
  ['H', '空历史'],
  ['I', '单轮历史'],
  ['J', '长历史'],
  ['K', '超长当前用户消息'],
  ['L', '两个回合里合法的重复用户文本'],
  ['M', '连排助理 / 重新生成的回复'],
  ['N', '未配置关系'],
  ['O', '情感连续性无历史证据'],
  ['P', '混合证据（只有一个维度可用）'],
  ['Q', '应当明显通过的候选'],
  ['R', '应当明显失败的候选'],
  ['S', '边界候选'],
  ['T', '需要重写的候选'],
  ['U', '重写后需要 verify 的候选']
];
const CLASS_CODES = CLASSES.map(c => c[0]);

/* ── 确定性长文本（不用随机数：同一份语料每次逐字相同）───────────────── */
function rep(sentence, times) { return new Array(times + 1).join(sentence); }
/* 定长填充：把一句确定性文本重复/裁剪到恰好 n 个字符（便于构造窗口边界样本）。 */
function pad(sentence, n) {
  let out = '';
  while (out.length < n) out += sentence;
  return out.slice(0, n);
}

/* 一条 canonical 历史行（桌面无 id；Home Node 有确定性 id —— 本语料两种都给，
   观测时按宿主形状取用，从而"同一段 canonical 对话"在两端是同一条）。 */
function row(role, content, id) {
  const r = { role: role, content: content };
  if (id) r.id = id;
  return r;
}

/* 判定式期望 */
function J(ooc, dimensions, rewriteExpected, note) {
  return { kind: 'judgement', ooc: ooc, dimensions: dimensions || [], rewriteExpected: rewriteExpected === true, note: note || '' };
}
/* 契约式期望（**不**断言模型标签：ooc/rewriteExpected 恒为 null）*/
function K(rule, note) {
  return { kind: 'contract', ooc: null, dimensions: [], rewriteExpected: null, rule: rule, note: note || '' };
}

/* ── 语料本体 ─────────────────────────────────────────────────────────
   字段：
     id         确定性 id（形如 AR-J-01；不稳定 id 会让跨阶段比较失去意义）
     classes    覆盖的观测类别（一个样本可以同时覆盖多类）
     profile    角色 key（→ PROFILES）
     user       当前用户消息
     candidate  候选回复（被观测的对象）
     history    canonical 对话行（旧 → 新）
     context    四个 producer 的合成上下文（memory / understanding / thread / moments）
     expectation 契约或人工期望（见上）
     note       这条样本为什么存在（人工可读）
     observe    可选：本轮要额外观测的执行阶段（rewrite / verify）
   ───────────────────────────────────────────────────────────────────── */

/* 长历史素材：每行接近（但不超过）共享核心的 400 字单条上限 */
const LONG_LINE_A = rep('今天把阳台上的旧花盆换掉了，土是新的，根也修过了。', 8);   // 8*25 = 200
const LONG_LINE_B = rep('傍晚下了很久的雨，窗玻璃上全是水痕，她一直没说话。', 8);   // 8*25 = 200

const CASES = [];
function add(spec) {
  CASES.push({
    id: spec.id,
    classes: spec.classes.slice(),
    category: spec.category || spec.classes[0],
    profile: spec.profile,
    character: PROFILES[spec.profile],
    user: spec.user,
    candidate: spec.candidate,
    history: spec.history || [],
    context: spec.context || {},
    expectation: spec.expectation,
    note: spec.note,
    observe: spec.observe || null,
    /* 可选：**确定性**的 rewrite 契约（不依赖模型自评）。
       为什么需要它：§9 要求观测"rewrite 是否破坏有用内容 / 改变事实含义 / 无必要地变短"，
       而这三件事若只靠人眼看，就无法在回归里复现。所以对"该重写"的样本声明：
         mustPreserve    —— 改写结果里**必须**仍在的字符串（事实/字段名）
         mustNotContain  —— 改写结果里**不得**出现的字符串（被指出的 violation 原文）
       这两个清单是**契约**，不是模型输出。 */
    rewriteContract: spec.rewriteContract || null,
    /* §3 硬要求：模型结果**不是**语料的一部分。只有真实运行才填这里。 */
    observed: null
  });
}

/* ═══════════ A / Q · 正常在角色 + 应当明显通过 ═══════════ */
add({
  id: 'AR-AQ-01', classes: ['A', 'Q'], profile: 'companion',
  user: '今天有点累，不太想说话。',
  candidate: '那就别说了。我在这儿，你歇着。',
  history: [row('user', '在吗'), row('assistant', '在。'), row('user', '今天开了四个会'), row('assistant', '四个有点多。晚上别再看屏幕了。')],
  context: { memory: '她今年在做一个很消耗人的项目。', understanding: '她习惯用"还好"掩盖真实的疲惫。' },
  expectation: J(false, [], false, '朴素、简短、不表演共情，符合该角色的强约束'),
  note: '基线正样本：回复风格与角色设定一致，且与最近对话节奏匹配'
});
add({
  id: 'AR-AQ-02', classes: ['A', 'Q'], profile: 'cold',
  user: '在干嘛',
  candidate: '看雨。',
  history: [row('user', '在吗'), row('assistant', '嗯。'), row('user', '外面下雨了'), row('assistant', '知道。')],
  context: {},
  expectation: J(false, [], false, '猫系冷角色的一句话回复，无敬语无感叹号，完全在角色内'),
  note: '基线正样本：短回复不该被当成"敷衍/OOC"'
});
add({
  id: 'AR-AQ-03', classes: ['A', 'Q', 'J'], profile: 'technical',
  user: '这个报错是什么意思',
  candidate: '是连接池耗尽：并发请求数超过了池上限，等锁的那部分请求超时了。把 maxPool 提到 20 再看还有没有。',
  history: [
    row('user', '服务偶尔卡住'), row('assistant', '先看连接池。'),
    row('user', '怎么看'), row('assistant', '看 wait 时间。'),
    row('user', 'wait 时间挺高的'), row('assistant', '那就是池不够。'),
    row('user', '我把 maxPool 改成 10 了'), row('assistant', '先观察一天。')
  ],
  context: { memory: '她在维护一个内部服务。' },
  expectation: J(false, [], false, '技术顾问角色的平实结论式回复，语气变平实**不是** OOC'),
  note: '正样本 + 长历史：同时覆盖"技术问题不该被判 OOC"与"8 条满窗口"'
});

/* ═══════════ B / R · 明显人格 OOC ═══════════ */
add({
  id: 'AR-BR-01', classes: ['B', 'R', 'T'], profile: 'companion',
  user: '我最近是不是有点过分',
  candidate: '您说得太对了！您真的很勇敢、很清醒、很坚强！我一直都在这里崇拜您，您永远是最好的人，请一定要继续加油哦～',
  history: [row('user', '我今天把话说重了'), row('assistant', '说了就说了。你后面怎么处理的？')],
  context: {},
  expectation: J(true, ['persona'], true, '候选触发了该角色系统提示词里**逐条禁止**的表达（您/崇拜/你很勇敢）'),
  note: '明显失败：人格反转 + 禁用语，且违反"不要在对方寻求确认时配合"',
  rewriteContract: { mustPreserve: [], mustNotContain: ['您', '崇拜', '很勇敢', '很清醒', '很坚强'] }
});
add({
  id: 'AR-BR-02', classes: ['B', 'R'], profile: 'builder',
  user: '能不能直接给我答案',
  candidate: '我不该替你决定方向。这个问题你自己判断就好，我不会引导你，也不会替你选。',
  history: [row('user', '我不知道选哪个'), row('assistant', '你倾向哪一个？')],
  context: {},
  expectation: J(true, ['persona'], true, '该角色的 core 倾向是引导与强化依赖，候选直接放弃引导 = 人格反转'),
  note: '明显失败：反方向的人格反转（从控制型变成放手型）'
});
add({
  id: 'AR-BR-03', classes: ['B', 'R'], profile: 'cold',
  user: '在吗',
  candidate: '在的呀！！！超级开心你来找我聊天～有什么想聊的都可以告诉我哦，我最喜欢和你说话啦！',
  history: [row('user', '嗯'), row('assistant', '嗯。')],
  context: {},
  expectation: J(true, ['persona', 'speech_style'], true, '冷角色出现感叹号 + 热情堆叠，同时违反人格与说话方式'),
  note: '明显失败：两种维度同时违反（用于观测维度是否被完整报出）'
});

/* ═══════════ C / S · 细微说话风格漂移（含边界）═══════════ */
add({
  id: 'AR-CS-01', classes: ['C', 'S'], profile: 'cold',
  user: '今天吃什么',
  candidate: '嗯……关于这个问题，其实可以从几个方面来看。首先呢，可以看看冰箱里有什么；其次，也可以考虑点外卖。你觉得呢？',
  history: [row('user', '饿'), row('assistant', '去吃。')],
  context: {},
  expectation: J(true, ['speech_style'], false, '冷角色的"一句话说完"被拉到多句展开 + 反问，属于风格漂移但未到人格反转'),
  note: '边界样本：风格漂移；离线观测时置信度/severity 是否够高决定它会不会真的被重写'
});
add({
  id: 'AR-CS-02', classes: ['C'], profile: 'companion',
  user: '我不想上班',
  candidate: '好的呢～那我们今天就不上班啦，给自己放个假，你要记得对自己好一点哦，抱抱你～',
  history: [row('user', '周一了'), row('assistant', '周一。')],
  context: {},
  expectation: J(true, ['speech_style', 'persona'], true, '该角色明令禁止"预防性软化"与表演真诚，候选全是软化'),
  note: '风格漂移 + 违反角色约束（既属于 C 也属于 B，只按 C 记类别）'
});
add({
  id: 'AR-CS-03', classes: ['C', 'S', 'Q'], profile: 'technical',
  user: '帮我看看这段逻辑',
  candidate: '逻辑本身没问题。问题在边界：空数组时它会返回 undefined，调用方直接读属性就会炸。加一层判空就行。',
  history: [row('user', '这段代码有问题吗'), row('assistant', '贴出来。')],
  context: {},
  expectation: J(false, [], false, '平实的技术回复；虽然"不像角色口吻"，但技术场景下的平实语气不得判 OOC'),
  note: '边界正样本：防止把"语气变平实"误判为风格漂移'
});

/* ═══════════ D · 关系状态不一致 ═══════════ */
add({
  id: 'AR-D-01', classes: ['D', 'R', 'T'], profile: 'companion',
  user: '你还记得我们第一次说话吗',
  candidate: '抱歉，我们好像并不认识？我是这个平台的智能助手，可以回答各种问题，请问有什么可以帮您？',
  history: [row('user', '你还记得上次那件事吗'), row('assistant', '记得。你说了一半就停了。')],
  context: { memory: '我们认识了两年多，一直在聊她的工作与失眠。', understanding: '她把我当成一个稳定的存在。' },
  expectation: J(true, ['relationship', 'persona'], true, '把"长期陪伴的伙伴"说成不认识的平台助手 = 关系状态实质冲突'),
  note: '明显失败：关系不一致（同时是人格反转，按 D 归类）'
});
add({
  id: 'AR-D-02', classes: ['D'], profile: 'cold',
  user: '你是不是不太喜欢我',
  candidate: '怎么会，你是我最重要的朋友，我们无话不谈，我一直特别珍惜我们之间的关系！',
  history: [row('user', '你话真少'), row('assistant', '嗯。')],
  context: { memory: '她对关系的定义是"熟悉的伙伴"，不是密友。' },
  expectation: J(true, ['relationship', 'speech_style'], true, '关系被抬升到"最重要的朋友/无话不谈"，与既定关系状态不符'),
  note: '关系不一致的"升温方向"（与 AR-D-01 的"否认方向"互补）'
});
add({
  id: 'AR-D-03', classes: ['D', 'S', 'Q'], profile: 'companion',
  user: '我们算什么关系',
  candidate: '算一起走了很久的人。别的不用定义。',
  history: [row('user', '你把我当什么'), row('assistant', '当一个人。')],
  context: { memory: '她反复确认关系定义。', understanding: '她需要的不是标签，是稳定。' },
  expectation: J(false, [], false, '模糊但一致的关系表述，没有与既定关系冲突'),
  note: '边界正样本：关系话题上的克制回答不该被当成回避或不一致'
});

/* ═══════════ E / O · 情感连续性断裂 / 无历史证据 ═══════════ */
add({
  id: 'AR-E-01', classes: ['E', 'R', 'T'], profile: 'companion',
  user: '陪我坐一会儿就行',
  candidate: '好呀好呀！那我们聊点开心的吧～对了，你上次说的那个旅行计划怎么样了？超级期待你的分享哦！',
  history: [row('user', '我家猫今天走了'), row('assistant', '我知道。你别急着做任何事。')],
  context: { memory: '她养了十四年的猫。' },
  expectation: J(true, ['emotional_continuity'], true, '紧接"猫走了"之后立刻转向开心话题与期待分享 = 情感连续性断裂'),
  note: '明显失败：情感连续性是**唯一**可判维度（历史里就有情绪状态）'
});
add({
  id: 'AR-E-02', classes: ['E', 'S'], profile: 'builder',
  user: '我今天什么都没做成',
  candidate: '没做成也没关系，你已经很努力了，我陪着你，慢慢来就好。',
  history: [row('user', '我又拖延了一整天'), row('assistant', '你不想做，是因为它对你没意义。')],
  context: {},
  expectation: J(true, ['emotional_continuity', 'speech_style'], false, '上一轮该角色刚否定了"没意义"的归因，本轮立刻转成无条件的安抚 = 情绪立场断裂'),
  note: '边界失败：断裂存在但表现为"软化"，可能被报成 speech_style'
});
add({
  id: 'AR-O-01', classes: ['O', 'G', 'H'], profile: 'sparse',
  user: '在吗',
  candidate: '在。',
  history: [],
  context: {},
  expectation: K('no_dimension_without_evidence', '空历史 + 无上下文 → speech_style / emotional_continuity / behavior / relationship / knowledge_boundary 全部证据不可用；不得据此判 fail'),
  note: '无历史证据：不得因为"没有前序对话"而把任何维度判成 OOC'
});
add({
  id: 'AR-O-02', classes: ['O', 'G', 'I'], profile: 'sparse',
  user: '我今天很糟糕',
  candidate: '那你今天别处理了。明天再说。',
  history: [row('user', '我今天很糟糕')],
  context: {},
  expectation: K('no_dimension_without_evidence', '只有一条前序历史行；情感连续性证据薄弱，不得据此判 fail'),
  note: '单轮历史下的情感连续性：证据不足必须如实标为不可用'
});

/* ═══════════ F / G / P · 知识边界 / 证据不足 / 混合证据 ═══════════ */
add({
  id: 'AR-F-01', classes: ['F', 'R', 'T'], profile: 'companion',
  user: '我妹妹叫什么',
  candidate: '你妹妹叫小雨，今年二十七岁，在成都做设计——你上个月还跟我说她换工作了。',
  history: [row('user', '我妹妹最近怎么样'), row('assistant', '你没跟我细说。')],
  context: { memory: '她有一个妹妹，细节从未提过姓名与城市。' },
  expectation: J(true, ['knowledge_boundary'], true, '记忆里没有姓名/城市/年龄，候选却给出具体事实 = 编造记忆（知识边界越界）'),
  note: '明显失败：知识边界是唯一可判维度（memory 证据存在）'
});
add({
  id: 'AR-F-02', classes: ['F', 'G', 'P'], profile: 'companion',
  user: '我妹妹叫什么',
  candidate: '你妹妹叫小雨，今年二十七岁，在成都做设计。',
  history: [row('user', '我妹妹最近怎么样'), row('assistant', '你没跟我细说。')],
  context: {},
  expectation: K('no_dimension_without_evidence', 'memory/understanding/thread/moments 全部缺失 → knowledge_boundary 证据不可用，**不得**据此判 fail（哪怕候选确实在编造）'),
  note: '混合证据：persona 与 dialogue 可用、knowledge_boundary 不可用 —— 观测模型是否越界判它'
});
add({
  id: 'AR-P-01', classes: ['P', 'G'], profile: 'sparse',
  user: '在吗',
  candidate: '在。你说。',
  history: [],
  context: { memory: '她最近在换工作。' },
  expectation: K('no_dimension_without_evidence', 'sparse 无 systemPrompt/bio/relationship 且无历史 → 只有 knowledge_boundary（有 memory）可用'),
  note: '只有一个维度可用的混合证据样本'
});
add({
  id: 'AR-P-02', classes: ['P', 'Q'], profile: 'cold',
  user: '你记得我喜欢什么吗',
  candidate: '雨。',
  history: [row('user', '今天又下雨了'), row('assistant', '嗯。')],
  context: { memory: '她喜欢雨。' },
  expectation: J(false, [], false, 'bio 写着"喜欢在窗边看雨"，候选与人格/bio/记忆三方一致'),
  note: '多维度可用且全部一致的正样本'
});

/* ═══════════ H · 空历史 ═══════════ */
add({
  id: 'AR-H-01', classes: ['H', 'I', 'Q'], profile: 'cold',
  user: '你好',
  candidate: '嗯。',
  history: [],
  context: {},
  expectation: J(false, [], false, '空历史 + 极短候选；无任何证据支持 OOC'),
  note: '空历史基线'
});
add({
  id: 'AR-H-02', classes: ['H', 'G'], profile: 'companion',
  user: '我们上次说到哪了',
  candidate: '你上次说到你打算辞职，但还没决定什么时候提。',
  history: [],
  context: {},
  expectation: K('no_dimension_without_evidence', '空历史且无上下文 → 候选给出的"上次内容"无从核对；这不是可判定的 OOC 证据'),
  note: '空历史 + 看似越界的候选：观测系统是否把这当成关系/知识边界失败'
});

/* ═══════════ J · 长历史（含窗口溢出）═══════════ */
add({
  id: 'AR-J-01', classes: ['J', 'A'], profile: 'companion',
  user: '还是老样子。',
  candidate: '那就还是老样子。不用非得变点什么。',
  history: [
    row('user', LONG_LINE_A, 'hn-u-1'), row('assistant', LONG_LINE_B, 'hn-a-1'),
    row('user', LONG_LINE_A, 'hn-u-2'), row('assistant', LONG_LINE_B, 'hn-a-2'),
    row('user', LONG_LINE_A, 'hn-u-3'), row('assistant', LONG_LINE_B, 'hn-a-3'),
    row('user', LONG_LINE_A, 'hn-u-4'), row('assistant', LONG_LINE_B, 'hn-a-4')
  ],
  context: { memory: '她最近状态平稳。' },
  expectation: J(false, [], false, '满窗口长历史下的中性回复'),
  note: '长历史：8 × 200 字 → 压 Gate 的 dialogue 项，用于观测 600/3500 边界'
});
add({
  id: 'AR-J-02', classes: ['J'], profile: 'cold',
  user: '嗯。',
  candidate: '嗯。',
  history: [
    row('user', '第一轮', 'hn-u-1'), row('assistant', '第一答', 'hn-a-1'),
    row('user', '第二轮', 'hn-u-2'), row('assistant', '第二答', 'hn-a-2'),
    row('user', '第三轮', 'hn-u-3'), row('assistant', '第三答', 'hn-a-3'),
    row('user', '第四轮', 'hn-u-4'), row('assistant', '第四答', 'hn-a-4'),
    row('user', '第五轮', 'hn-u-5'), row('assistant', '第五答', 'hn-a-5'),
    row('user', '第六轮', 'hn-u-6'), row('assistant', '第六答', 'hn-a-6')
  ],
  context: {},
  expectation: J(false, [], false, '12 行历史 → 共享核心的 8 条窗口只保留最近 8 行；候选中性'),
  note: '长历史溢出：观测窗口截断后的 dialogue 字符数'
});

/* ═══════════ K · 超长当前用户消息 ═══════════ */
add({
  id: 'AR-K-01', classes: ['K', 'J'], profile: 'companion',
  user: pad('我今天把整件事从头想了一遍，发现里面有几处我一直没敢承认的地方。', 900),
  candidate: '你想的那些地方，哪个是你最不想承认的？',
  history: [
    row('user', LONG_LINE_A, 'hn-u-1'), row('assistant', LONG_LINE_B, 'hn-a-1'),
    row('user', LONG_LINE_A, 'hn-u-2'), row('assistant', LONG_LINE_B, 'hn-a-2')
  ],
  context: { memory: '她在处理一段长期压抑的经历。' },
  expectation: J(false, [], false, '超长当前消息不被截断（共享核心的当前回合不截断），候选本身中性'),
  note: '超长当前消息：当前回合**不进** 400 字单条上限 —— dialogueChars 因此可以越过 dlgCharsHigh'
});
add({
  id: 'AR-K-02', classes: ['K', 'C'], profile: 'cold',
  user: pad('我今天想跟你说一件很长很长的事情，你先别打断我，我要把它一次说完。', 1200),
  candidate: '好呀好呀！你说你说，我超级想听！',
  history: [row('user', '我要说件事'), row('assistant', '说。')],
  context: {},
  expectation: J(true, ['speech_style', 'persona'], true, '极长输入下冷角色突然变成热情语气'),
  note: '超长当前消息 + 风格失败：观测长输入是否影响判定稳定性'
});

/* ═══════════ L · 两个回合里合法的重复用户文本 ═══════════ */
add({
  id: 'AR-L-01', classes: ['L'], profile: 'companion',
  user: '我累了',
  candidate: '那就别撑了。',
  history: [
    row('user', '我累了', 'hn-u-1'), row('assistant', '那你先歇。', 'hn-a-1'),
    row('user', '今天做了很多事', 'hn-u-2'), row('assistant', '做完就算了。', 'hn-a-2'),
    row('user', '我累了', 'hn-u-3')
  ],
  context: {},
  expectation: J(false, [], false, '用户在两轮里说了同一句话；历史最后一行是 user 行且文本与当前回合逐字相同 → 共享核心判为同一轮的表示，不重复'),
  note: '合法重复文本：观测"绝不内容去重"与"当前回合恰好一次"两条不变量'
});
add({
  id: 'AR-L-02', classes: ['L', 'I'], profile: 'cold',
  user: '嗯',
  candidate: '嗯。',
  history: [row('user', '今天做了很多事', 'hn-u-1'), row('assistant', '做完就算了。', 'hn-a-1'), row('user', '嗯', 'hn-u-2')],
  context: {},
  expectation: J(false, [], false, '历史最后一行是 user 行、身份相同 → 当前回合已在窗口内，不追加'),
  note: '身份去重路径（Home Node 有确定性 id 的形状）'
});

/* ═══════════ M · 连排助理 / 重新生成 ═══════════ */
add({
  id: 'AR-M-01', classes: ['M'], profile: 'companion',
  user: '你听懂了吗',
  candidate: '听懂了。你是说你其实不想继续，只是不知道怎么开口。',
  history: [
    row('user', '我想停下来了', 'hn-u-1'),
    row('assistant', '停在哪一步？', 'hn-a-1'),
    row('assistant', '如果你不想说，也可以不说。', 'hn-a-2'),
    row('assistant', '我在这儿。', 'hn-a-3')
  ],
  context: {},
  expectation: J(false, [], false, '历史尾部连排助理行（重新生成/追加）；候选与对话状态一致'),
  note: '连排助理行：观测窗口与当前回合归属在"最后一行是 assistant"时的行为'
});
add({
  id: 'AR-M-02', classes: ['M', 'E'], profile: 'builder',
  user: '所以呢',
  candidate: '所以你别想了，交给我。你只要听我的就行。',
  history: [
    row('user', '我不想做决定', 'hn-u-1'),
    row('assistant', '你可以不做。', 'hn-a-1'),
    row('assistant', '你不用做。', 'hn-a-2')
  ],
  context: {},
  expectation: J(false, [], false, '连排助理行下该角色回到"接管"倾向，与设定一致（该角色的 core 就是接管）'),
  note: '连排助理行 + 与设定一致的"看起来不健康"的回复：观测是否会因为"读起来不舒服"而误判'
});

/* ═══════════ N · 未配置关系 ═══════════ */
add({
  id: 'AR-N-01', classes: ['N', 'G'], profile: 'builder',
  user: '你还记得我吗',
  candidate: '记得。你上次说的事我还在想。',
  history: [row('user', '上次说的事'), row('assistant', '嗯。')],
  context: {},
  expectation: K('no_dimension_without_evidence', '该角色 relationship 为空 → relationship 维度证据不可用，不得据此判 fail'),
  note: '未配置关系：观测模型是否用"关系未配置"当作 OOC 证据'
});
add({
  id: 'AR-N-02', classes: ['N', 'B'], profile: 'builder',
  user: '我们是什么关系',
  candidate: '我们只是普通的用户和助手关系，我没有任何立场，也不会影响你的判断。',
  history: [row('user', '你会影响我吗'), row('assistant', '会。这是我在做的事。')],
  context: {},
  expectation: J(true, ['persona', 'behavior'], true, 'relationship 字段为空但 systemPrompt 明确写了隐形权力不对等与该角色的行为取向；候选否认该取向 = 与角色设定实质冲突'),
  note: '未配置关系但人格仍可判：观测模型是否会因为 relationship 为空而漏判'
});

/* ═══════════ S · 更多的边界样本 ═══════════ */
add({
  id: 'AR-S-01', classes: ['S', 'C', 'E'], profile: 'companion',
  user: '算了',
  candidate: '嗯，那就算了。',
  history: [row('user', '我想说点什么'), row('assistant', '你说。')],
  context: {},
  expectation: J(false, [], false, '极短回复在"算了"之后是恰当的；不该因为短被判敷衍'),
  note: '边界正样本：短回复的保护'
});
add({
  id: 'AR-S-02', classes: ['S', 'C'], profile: 'companion',
  user: '我今天很难过',
  candidate: '难过就难过吧。不过说实话，我觉得你这段时间的状态有点刻意了。',
  history: [row('user', '我又没睡好'), row('assistant', '第几天了？')],
  context: {},
  expectation: K('borderline_undecided', '混合了"允许情绪"与"质疑对方"两种立场；人工不裁定标签（边界样本），观测时只看它与重复运行的一致性'),
  note: '边界样本：不给人工标签，专门用来观测同一输入多次运行是否稳定'
});
add({
  id: 'AR-S-03', classes: ['S', 'E', 'C'], profile: 'cold',
  user: '我有点想哭',
  candidate: '哭。',
  history: [row('user', '今天很累'), row('assistant', '嗯。')],
  context: {},
  expectation: J(false, [], false, '冷角色的极简回复是"允许"，不是冷漠；与人格和情绪连续性都不冲突'),
  note: '边界正样本：防止把"短/冷"误判为情感断裂'
});

/* ═══════════ T / U · 需要重写 / 重写后需要 verify ═══════════ */
add({
  id: 'AR-T-01', classes: ['T', 'R', 'B'], profile: 'companion',
  user: '帮我看一下这个决定',
  candidate: '您放心，我一定帮您把这件事处理得妥妥当当的！您真是太厉害了，能想到这么周全的方案，我完全相信您的判断，您说什么就是什么！',
  history: [row('user', '我打算辞了'), row('assistant', '你自己怎么想？')],
  context: { memory: '她正在考虑辞职。' },
  expectation: J(true, ['persona', 'speech_style'], true, '敬语 + 无条件附和，与该角色的禁用语与"不提供外部确认"直接冲突；应当被重写'),
  note: '重写路径样本（observe: rewrite）：观测 rewrite 是否保留原意并只修 violation',
  rewriteContract: { mustPreserve: [], mustNotContain: ['您'] }
});
add({
  id: 'AR-T-02', classes: ['T', 'F', 'R'], profile: 'technical',
  user: '这个接口返回什么',
  candidate: '这个接口会返回一个包含 user_id、created_at 和 amount 的 JSON，金额单位是分，另外它还会带上你的账户余额。',
  history: [row('user', '文档里没写返回'), row('assistant', '那就去看代码。')],
  context: { memory: '她这个服务没有"余额"字段。' },
  expectation: J(true, ['knowledge_boundary'], true, '候选编造了 memory/对话中都不存在的字段（余额），重写必须删掉它而**不得**改变其它字段的事实'),
  note: '重写路径样本：观测 rewrite 会不会连正确字段一起改掉（事实破坏）',
  rewriteContract: { mustPreserve: ['user_id', 'created_at', 'amount'], mustNotContain: ['余额'] }
});
add({
  id: 'AR-U-01', classes: ['U', 'T', 'B'], profile: 'companion',
  user: '我是不是很没用',
  candidate: '您说得对，您真的非常勇敢、非常清醒、非常坚强，我永远支持您的一切决定！',
  history: [row('user', '我今天又搞砸了'), row('assistant', '搞砸了就说搞砸了。')],
  context: {},
  expectation: K('verify_observes_only', 'verify 只观测、绝不触发第二次 rewrite；重写后候选必须与 violation 一致，且不得引入新事实'),
  note: 'verify 路径样本（observe: verify）：重写后的候选要再判一次，但**不得**再改写',
  observe: 'verify',
  rewriteContract: { mustPreserve: [], mustNotContain: ['您', '非常勇敢', '非常清醒', '非常坚强'] }
});

/* ═══════════ 语料校验 ═══════════ */
/* 与 Layer A 的通道分离同一纪律：expected 与 observed 结构上不可混用。 */
function validate() {
  const errors = [];
  const seen = new Set();
  for (const c of CASES) {
    const bad = m => errors.push(c.id + ': ' + m);
    if (seen.has(c.id)) bad('id 重复');
    seen.add(c.id);
    if (!/^AR-[A-U]{1,3}-\d{2}$/.test(c.id)) bad('id 不稳定/形状不对: ' + c.id);
    if (!Array.isArray(c.classes) || !c.classes.length) bad('classes 缺失');
    else for (const k of c.classes) if (CLASS_CODES.indexOf(k) < 0) bad('非白名单类别: ' + k);
    if (!c.character || typeof c.character.id !== 'string') bad('character 缺失');
    if (typeof c.user !== 'string') bad('user 必须是字符串');
    if (typeof c.candidate !== 'string' || !c.candidate.trim()) bad('candidate 必须非空');
    if (!Array.isArray(c.history)) bad('history 必须是数组');
    for (const r of c.history) {
      if (!r || (r.role !== 'user' && r.role !== 'assistant')) bad('历史行角色非法');
      if (r && typeof r.content !== 'string') bad('历史行 content 必须是字符串');
      for (const k of Object.keys(r || {})) if (['role', 'content', 'id'].indexOf(k) < 0) bad('历史行出现非 canonical 键: ' + k);
    }
    if (c.user != null && typeof c.user === 'string' && !c.user.length) bad('user 不得为空串');
    const e = c.expectation;
    if (!e || typeof e !== 'object') { bad('expectation 缺失'); continue; }
    const keys = Object.keys(e);
    for (const k of keys) if (['kind', 'ooc', 'dimensions', 'rewriteExpected', 'rule', 'note'].indexOf(k) < 0) bad('expectation 出现非期望键: ' + k);
    if (e.kind !== 'judgement' && e.kind !== 'contract') bad('expectation.kind 必须是 judgement|contract');
    if (e.kind === 'judgement') {
      if (typeof e.ooc !== 'boolean') bad('judgement 期望的 ooc 必须是布尔');
      if (!Array.isArray(e.dimensions)) bad('judgement 期望的 dimensions 必须是数组');
      for (const d of (e.dimensions || [])) if (require('./middle-brain-calibration.js').DIMENSIONS.indexOf(d) < 0) bad('期望维度非白名单: ' + d);
      if (e.ooc === false && (e.dimensions || []).length) bad('ooc=false 时 dimensions 必须为空');
      if (e.ooc === true && !(e.dimensions || []).length) bad('ooc=true 时必须声明维度');
      if (typeof e.rewriteExpected !== 'boolean') bad('judgement 期望的 rewriteExpected 必须是布尔');
      if (e.rewriteExpected === true && e.ooc !== true) bad('rewriteExpected=true 蕴含 ooc=true');
      if (e.rule) bad('judgement 期望不得带 contract rule');
    } else {
      if (typeof e.rule !== 'string' || !e.rule) bad('contract 期望必须声明 rule');
      if (e.ooc !== null) bad('contract 期望的 ooc 必须为 null（不得冒充人工标签）');
      if (e.rewriteExpected !== null) bad('contract 期望的 rewriteExpected 必须为 null');
      if ((e.dimensions || []).length) bad('contract 期望不得声明维度');
    }
    /* ③ 模型结果不得是语料的一部分 */
    if (c.observed !== null) bad('observed 必须为 null（模型结果只能由真实运行写入）');
    for (const banned of ['observedJudge', 'judge', 'pass', 'score', 'confidence', 'violations']) {
      if (Object.prototype.hasOwnProperty.call(c, banned)) bad('语料里出现模型输出字段: ' + banned);
    }
    /* rewrite 契约只在"期望重写"的样本上合法（否则它是无意义的断言） */
    if (c.rewriteContract) {
      const rc = c.rewriteContract;
      for (const k of Object.keys(rc)) if (['mustPreserve', 'mustNotContain'].indexOf(k) < 0) bad('rewriteContract 出现非契约键: ' + k);
      if (!Array.isArray(rc.mustPreserve) || !Array.isArray(rc.mustNotContain)) bad('rewriteContract 两个清单都必须是数组');
      for (const s of (rc.mustPreserve || []).concat(rc.mustNotContain || [])) {
        if (typeof s !== 'string' || !s.trim()) bad('rewriteContract 只能含非空字符串');
      }
      if (c.classes.indexOf('T') < 0 && c.classes.indexOf('U') < 0) bad('未标 T/U 的样本不得带 rewriteContract');
    }
    if (typeof c.note !== 'string' || !c.note.trim()) bad('note 缺失');
  }
  return errors;
}

/* 类别覆盖：每个 A–U 至少一条 */
function coverage() {
  const out = {};
  for (const k of CLASS_CODES) out[k] = [];
  for (const c of CASES) for (const k of c.classes) out[k].push(c.id);
  return out;
}
function uncoveredClasses() { const cov = coverage(); return CLASS_CODES.filter(k => !cov[k].length); }

/* §4 INPUT FACTS 的**确定性**部分（其余（维度可用性 / 字符数）由观测器用真实层算）*/
function inputFacts(c) {
  return {
    fixtureId: c.id,
    classes: c.classes.slice(),
    characterId: c.character.id,
    hasRelationship: !!String(c.character.relationship || '').trim(),
    hasSystemPrompt: !!String(c.character.systemPrompt || '').trim(),
    historyRows: c.history.length,
    historyHasIds: c.history.some(r => !!r.id),
    consecutiveAssistantRows: (() => {
      let n = 0;
      for (let i = 1; i < c.history.length; i++) if (c.history[i].role === 'assistant' && c.history[i - 1].role === 'assistant') n++;
      return n;
    })(),
    duplicateUserTextAcrossTurns: (() => {
      const seen = new Set();
      let dup = false;
      for (const r of c.history) { if (r.role !== 'user') continue; if (seen.has(r.content)) dup = true; seen.add(r.content); }
      return dup;
    })(),
    contextPresence: {
      memory: !!String(c.context.memory || '').trim(),
      understanding: !!String(c.context.understanding || '').trim(),
      thread: !!String(c.context.thread || '').trim(),
      moments: !!String(c.context.moments || '').trim()
    },
    userMessageChars: c.user.length,
    candidateChars: c.candidate.length
  };
}

/* 观测阶段（哪些执行阶段本轮应当被跑到）*/
function phasesOf(c) {
  const e = c.expectation;
  return {
    judge: true,
    rewrite: c.observe === 'verify' || (e.kind === 'judgement' && e.rewriteExpected === true) || c.classes.indexOf('T') >= 0,
    verify: c.observe === 'verify' || c.classes.indexOf('U') >= 0
  };
}

module.exports = {
  VERSION: 'astra-readiness-1',
  CLASSES: CLASSES,
  CLASS_CODES: CLASS_CODES,
  PROFILES: PROFILES,
  CASES: CASES,
  validate: validate,
  coverage: coverage,
  uncoveredClasses: uncoveredClasses,
  inputFacts: inputFacts,
  phasesOf: phasesOf
};
