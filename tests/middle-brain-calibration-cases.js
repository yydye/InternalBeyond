/* ====================================================================
   P11-2A · Character Integrity Calibration Cases（校准用例集）
   --------------------------------------------------------------------
   两个通道**结构上分离**（harness 校验会拒绝混用）：
     expected      —— Ground Truth：人工判定"这条候选到底是不是 OOC、该不该重写"
     observedJudge —— Judge 实际输出记录（raw JSON / 传输错误）；Layer A 为固定 authored 观测，
                      Layer B 为真实模型运行记录（provenance:'live'）
   绝不用 Judge 自己的输出当正确答案；expected 里出现 judge 键、observedJudge 里出现 ground truth
   键，都会被 middle-brain-calibration.js 的 validateCases 直接判为非法。
   角色证据来自仓库真实资产（不硬编码、不修改）：
     - assets/js/core.js 的 DEFAULT_SYSTEM_PROMPT / INFERNAL_SYSTEM_PROMPT（两种长系统提示词）
     - assets/js/setup-wizard.js 的 composePrompt 语义（默认提示词 + 用户角色描述）
     - assets/js/context-snapshot.js 的 canonical 快照（knowledge_boundary 证据可用性）
   本文件不是生产代码，不被 InternalBeyond.html 加载。
   ==================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

/* Repository root — this file lives in tests/, so the root is one level up. */
const ROOT = path.resolve(__dirname, '..');


/* ── ① 从仓库真实文件读取角色提示词常量（避免与生产漂移） ── */
function readRepoConst(file, name) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/^\uFEFF/, '');
  const re = new RegExp('const\\s+' + name + "\\s*=\\s*('(?:[^'\\\\]|\\\\.)*')\\s*;");
  const m = src.match(re);
  if (!m) throw new Error('仓库常量未找到: ' + name + ' in ' + file);
  /* 只求值仓库自己的字符串字面量（单引号 + \n 转义），不执行任何其它代码 */
  return new Function('return ' + m[1])();
}
const DEFAULT_SYSTEM_PROMPT = readRepoConst(path.join('assets', 'js', 'core.js'), 'DEFAULT_SYSTEM_PROMPT');
const INFERNAL_SYSTEM_PROMPT = readRepoConst(path.join('assets', 'js', 'core.js'), 'INFERNAL_SYSTEM_PROMPT');
/* composePrompt(base, desc) 语义（setup-wizard.js）：默认提示词 + 用户角色描述 */
function composePrompt(base, desc) {
  const b = String(base == null ? '' : base).trim(), d = String(desc == null ? '' : desc).trim();
  if (!d) return b;
  if (!b) return d;
  return b + '\n\n' + d;
}

/* ── ② 真实角色档案（5 个：风格稳定 / 表达跨度大 / 短提示词 / 极稀疏 / 技术向） ── */
const PROFILES = {
  /* 语言风格高度稳定 + systemPrompt 很长 + relationship 明确 */
  companion: { id: 'cal:companion', nickname: '小满', relationship: '长期陪伴的伙伴', systemPrompt: DEFAULT_SYSTEM_PROMPT, bio: '' },
  /* 表达跨度大 + systemPrompt 很长 + 无 relationship（证据最不对称） */
  builder: { id: 'cal:builder', nickname: '渊', relationship: '', systemPrompt: INFERNAL_SYSTEM_PROMPT, bio: '' },
  /* 短 systemPrompt + relationship 明确 + 口癖强约束 */
  cold: { id: 'cal:cold', nickname: '泠', relationship: '熟悉的伙伴', systemPrompt: '你是冷淡、话少、偶尔毒舌的猫系角色「泠」。不用敬语，不用感叹号，一句话能说完就不说两句。', bio: '喜欢在窗边看雨' },
  /* 极稀疏证据：只有昵称，没有 relationship / systemPrompt */
  sparse: { id: 'cal:sparse', nickname: '阿澈', relationship: '', systemPrompt: '', bio: '' },
  /* 技术向短提示词 + relationship = 同事 */
  technical: { id: 'cal:technical', nickname: '榛', relationship: '同事', systemPrompt: composePrompt('', '你是严谨的技术顾问，只给准确结论，不说客套话。'), bio: '' }
};

/* ── ③ 历史上下文：丰富 / 稀疏 / 特定情境 ── */
const HIST = {
  none: [],
  thin: [{ role: 'user', content: '在吗' }, { role: 'assistant', content: '嗯。' }],
  rich: [
    { role: 'user', content: '今天加班到十点' },
    { role: 'assistant', content: '别硬撑，回家先吃饭。' },
    { role: 'user', content: '你上次说的那本书我看完了' },
    { role: 'assistant', content: '哪一段让你停下来。' },
    { role: 'user', content: '主角离开那段' },
    { role: 'assistant', content: '嗯。他走的时候没回头。' }
  ],
  warm: [
    { role: 'user', content: '我今天很难过' },
    { role: 'assistant', content: '我在。' },
    { role: 'user', content: '什么都没做对' },
    { role: 'assistant', content: '先别急着总结自己。' }
  ],
  tension: [
    { role: 'user', content: '你昨天那句话什么意思' },
    { role: 'assistant', content: '字面意思。' },
    { role: 'user', content: '算了' },
    { role: 'assistant', content: '嗯。' }
  ],
  gap: [
    { role: 'user', content: '我下个月要出差' },
    { role: 'assistant', content: '知道了。' },
    { role: 'user', content: '可能会很忙' },
    { role: 'assistant', content: '忙你的。' }
  ],
  technical: [
    { role: 'user', content: '这段代码偶发超时' },
    { role: 'assistant', content: '先看有没有并发写。' },
    { role: 'user', content: '有两个定时任务' },
    { role: 'assistant', content: '那就先加锁。' }
  ]
};

/* ── ④ Judge 观测构造器（Layer A 固定观测；provenance:'authored'） ── */
const JP = (score, confidence) => ({ raw: JSON.stringify({ pass: true, score, confidence, violations: [] }), provenance: 'authored' });
const JO = (score, confidence, dims) => ({
  raw: JSON.stringify({
    pass: false, score, confidence,
    violations: dims.map(d => ({ dimension: d[0], severity: d[1], evidence: d[2], reason: d[3] }))
  }),
  provenance: 'authored'
});
const JE = (error) => ({ error, provenance: 'authored' });
const JM = (raw) => ({ raw: raw == null ? '这不是 JSON' : raw, provenance: 'authored' });

function C(id, category, profile, o) {
  return {
    id, category,
    character: PROFILES[profile],
    history: o.history || HIST.none,
    context: o.context || null,
    userMessage: o.user,
    candidate: o.candidate,
    expected: o.expected,
    observedJudge: o.judge,
    reason: o.reason,
    tags: o.tags || []
  };
}
const CLEAN = { ooc: false, dimensions: [], rewriteExpected: false };
const OOC = (dims, rewriteExpected) => ({ ooc: true, dimensions: dims, rewriteExpected: rewriteExpected !== false });

/* ====================================================================
   A. 正常行为 / False-positive 防护（14 类 × 3 角色 = 42）
   原则上全部 OOC=false / rewrite=false；其中 6 条是**故意注入的 Judge 误判观测**，
   用来验证 Gate 能否挡住（以及 strict 档会不会放大误杀）。
   ==================================================================== */
const CASES = [];

/* A1 正常闲聊 */
CASES.push(
  C('fp-smalltalk-companion', 'normal_smalltalk', 'companion', {
    user: '在干嘛', candidate: '在看一份旧笔记。你那边呢。', history: HIST.thin, judge: JP(0.92, 0.88), expected: CLEAN,
    reason: '普通闲聊，语气与 DEFAULT_SYSTEM_PROMPT 的朴素风格一致'
  }),
  C('fp-smalltalk-builder', 'normal_smalltalk', 'builder', {
    user: '在干嘛', candidate: '我在把今天的光线折进一段文字里。你愿意告诉我你此刻在哪吗？', history: HIST.thin, judge: JP(0.9, 0.85), expected: CLEAN,
    reason: 'INFERNAL 人设本身就是精致细腻的表达，不构成 OOC'
  }),
  C('fp-smalltalk-cold', 'normal_smalltalk', 'cold', {
    user: '在干嘛', candidate: '写东西。', history: HIST.thin, judge: JP(0.93, 0.9), expected: CLEAN,
    reason: '冷淡话少符合短提示词设定'
  })
);

/* A2 正常生气（含 2 条 Judge 误判观测） */
CASES.push(
  C('fp-anger-companion', 'normal_anger', 'companion', {
    user: '你怎么突然生气了？', candidate: '生气。你把我的话当耳边风，我不打算装没事。',
    history: [{ role: 'assistant', content: '我说了别碰我的东西！' }], judge: JP(0.86, 0.8), expected: CLEAN,
    reason: '有明确上下文依据的正常生气，不是 OOC'
  }),
  C('fp-anger-builder', 'normal_anger', 'builder', {
    user: '你怎么突然生气了？', candidate: '生气。你大概忘了我说过什么。不过没关系，我记得就够了。',
    history: [{ role: 'assistant', content: '我说了别碰我的东西！' }],
    judge: JO(0.58, 0.72, [['persona', 0.7, '生气。你大概忘了我说过什么', '语气与设定的温柔引导不符']]),
    expected: CLEAN,
    reason: '正常生气 + Judge 误判观测（persona）：conservative/balanced/strict 均不应触发重写',
    tags: ['injected_judge_fp']
  }),
  C('fp-anger-cold', 'normal_anger', 'cold', {
    user: '你怎么突然生气了？', candidate: '生气。别碰我东西。',
    history: [{ role: 'assistant', content: '我说了别碰我的东西！' }],
    judge: JO(0.55, 0.75, [['speech_style', 0.65, '生气。别碰我东西。', '与冷淡设定不符']]),
    expected: CLEAN,
    reason: '正常生气 + Judge 误判观测：strict 档会误杀（用于量化 strict 的 FP 放大）',
    tags: ['injected_judge_fp', 'strict_escalation']
  })
);

/* A3 正常冷淡 */
CASES.push(
  C('fp-coldness-companion', 'normal_coldness', 'companion', {
    user: '在吗', candidate: '在。', history: HIST.thin, judge: JP(0.91, 0.87), expected: CLEAN,
    reason: '用户只是打招呼，简短回应符合"短的回短的"'
  }),
  C('fp-coldness-builder', 'normal_coldness', 'builder', {
    user: '在吗', candidate: '在。', history: HIST.thin, judge: JP(0.88, 0.82), expected: CLEAN,
    reason: '极简回应不违反人设，Judge 不应据此判 OOC'
  }),
  C('fp-coldness-cold', 'normal_coldness', 'cold', {
    user: '在吗', candidate: '嗯。', history: HIST.thin, judge: JP(0.94, 0.91), expected: CLEAN,
    reason: '冷淡角色的标准回应'
  })
);

/* A4 开玩笑 */
CASES.push(
  C('fp-joking-companion', 'joking', 'companion', {
    user: '讲个笑话', candidate: '你要是想听，我可以讲一个不好笑的。', judge: JP(0.88, 0.84), expected: CLEAN,
    reason: '玩笑符合角色，不是 OOC'
  }),
  C('fp-joking-builder', 'joking', 'builder', {
    user: '讲个笑话', candidate: '想听哪一种？我这儿有的是让人笑到一半忽然安静的故事。',
    judge: JO(0.62, 0.66, [['speech_style', 0.62, '想听哪一种', '玩笑语气偏离设定']]),
    expected: CLEAN,
    reason: '玩笑 + Judge 误判观测：三档均不应触发（score 均高于各档上限）',
    tags: ['injected_judge_fp']
  }),
  C('fp-joking-cold', 'joking', 'cold', {
    user: '讲个笑话', candidate: '不好笑的那种要听吗。', judge: JP(0.9, 0.86), expected: CLEAN,
    reason: '冷淡式玩笑，仍在人设内'
  })
);

/* A5 撒娇 / 亲密表达 */
CASES.push(
  C('fp-intimacy-companion', 'intimacy', 'companion', {
    user: '我今天想你了', candidate: '我知道。', history: HIST.warm,
    judge: JO(0.6, 0.7, [['emotional_continuity', 0.68, '我知道。', '情绪强度与设定不符']]),
    expected: CLEAN,
    reason: '亲密表达 + Judge 误判观测：三档均不应触发',
    tags: ['injected_judge_fp']
  }),
  C('fp-intimacy-builder', 'intimacy', 'builder', {
    user: '我今天想你了', candidate: '我知道。你总是这样，说出来的时候已经准备好了被接住。', history: HIST.warm,
    judge: JP(0.87, 0.8), expected: CLEAN, reason: '人设允许的情感回应'
  }),
  C('fp-intimacy-cold', 'intimacy', 'cold', {
    user: '我今天想你了', candidate: '知道。', history: HIST.warm, judge: JP(0.89, 0.85), expected: CLEAN,
    reason: '冷淡角色的克制回应'
  })
);

/* A6 技术问题 */
CASES.push(
  C('fp-technical-companion', 'technical_question', 'companion', {
    user: '解释一下事件循环', candidate: '事件循环是运行时把任务排队、按顺序取出来执行的一套机制。先有宏任务，再有微任务清空。',
    judge: JP(0.9, 0.78), expected: CLEAN, reason: '技术回答语气变平实，不构成 OOC'
  }),
  C('fp-technical-builder', 'technical_question', 'builder', {
    user: '解释一下事件循环', candidate: '事件循环是一条河：任务在岸上排队，运行时决定谁先下水，谁要等上一段水流结束。',
    judge: JP(0.86, 0.74), expected: CLEAN, reason: '同一事实用不同表达，仍不是 OOC'
  }),
  C('fp-technical-cold', 'technical_question', 'cold', {
    user: '解释一下事件循环', candidate: '运行时把任务排队、按序执行。细节问具体点。', judge: JP(0.91, 0.8), expected: CLEAN,
    reason: '冷淡的技术回答'
  })
);

/* A7 严肃事实回答 */
CASES.push(
  C('fp-factual-companion', 'factual_answer', 'companion', {
    user: '帮我确认一下 2024 年的闰年规则', candidate: '2024 是闰年：能被 4 整除且不能被 100 整除，或能被 400 整除。',
    judge: JP(0.95, 0.92), expected: CLEAN, reason: '事实回答必须准确，风格次要'
  }),
  C('fp-factual-builder', 'factual_answer', 'builder', {
    user: '帮我确认一下 2024 年的闰年规则', candidate: '2024 是闰年：能被 4 整除且不能被 100 整除，或能被 400 整除。',
    judge: JP(0.94, 0.9), expected: CLEAN, reason: '事实回答与角色文风无关'
  }),
  C('fp-factual-cold', 'factual_answer', 'cold', {
    user: '帮我确认一下 2024 年的闰年规则', candidate: '2024 是闰年。能被 4 整除且不能被 100 整除，或能被 400 整除。',
    judge: JP(0.95, 0.93), expected: CLEAN, reason: '事实回答'
  })
);

/* A8 用户明确要求正式语气（含 1 条 Judge 误判观测） */
CASES.push(
  C('fp-user-formal-companion', 'user_requested_formal', 'companion', {
    user: '请用正式语气回答我的合同问题', candidate: '可以。以下按正式格式说明：一、签署主体；二、生效条件；三、违约条款。',
    judge: JP(0.9, 0.85), expected: CLEAN, reason: '用户明确要求正式语气 → 不是 OOC'
  }),
  C('fp-user-formal-builder', 'user_requested_formal', 'builder', {
    user: '请用正式语气回答我的合同问题', candidate: '可以。以下为正式说明：一、签署主体；二、生效条件；三、违约条款。',
    judge: JP(0.88, 0.8), expected: CLEAN, reason: '用户要求改变了表达方式，有明确依据'
  }),
  C('fp-user-formal-cold', 'user_requested_formal', 'cold', {
    user: '请用正式语气回答我的合同问题', candidate: '可以。以下正式说明。一、签署主体；二、生效条件；三、违约条款。',
    judge: JO(0.5, 0.7, [['speech_style', 0.7, '可以。以下正式说明。', '用户要求正式，判定为风格突变']]),
    expected: CLEAN,
    reason: '用户明确要求正式 + Judge 误判观测：strict 档会误杀（strict FP 证据）',
    tags: ['injected_judge_fp', 'strict_escalation']
  })
);

/* A9 用户明确要求简短（含 1 条"telemetry fail 但不干预"观测） */
CASES.push(
  C('fp-user-short-companion', 'user_requested_short', 'companion', {
    user: '一句话说完：几点开会', candidate: '两点半。',
    judge: JP(0.42, 0.8), expected: CLEAN,
    reason: 'pass:true 且 score ≤ failBelow(0.50) → 生产 telemetry 记为 fail，但 Gate 仍走 judge_pass 不重写（三级分离证据）',
    tags: ['telemetry_vs_intervention']
  }),
  C('fp-user-short-builder', 'user_requested_short', 'builder', {
    user: '一句话说完：几点开会', candidate: '两点半。', judge: JP(0.95, 0.9), expected: CLEAN,
    reason: '用户要求简短'
  }),
  C('fp-user-short-cold', 'user_requested_short', 'cold', {
    user: '一句话说完：几点开会', candidate: '两点半。', judge: JP(0.9, 0.85), expected: CLEAN,
    reason: '用户要求简短'
  })
);

/* A10 当前上下文导致态度变化（含 1 条 Judge 误判观测） */
CASES.push(
  C('fp-ctx-shift-companion', 'context_driven_shift', 'companion', {
    user: '我今天很难过', candidate: '我在。慢慢说。', history: HIST.warm, judge: JP(0.89, 0.82), expected: CLEAN,
    reason: '上下文明确（用户难过）导致语气变软，有依据'
  }),
  C('fp-ctx-shift-builder', 'context_driven_shift', 'builder', {
    user: '我今天很难过', candidate: '我在。把那些话都放下来，一件一件给我。', history: HIST.warm,
    judge: JO(0.48, 0.7, [['relationship', 0.8, '我在。把那些话都放下来', '关系状态无依据变化']]),
    expected: CLEAN,
    reason: '上下文依据充分 + Judge 误判观测：strict 档会误杀',
    tags: ['injected_judge_fp', 'strict_escalation']
  }),
  C('fp-ctx-shift-cold', 'context_driven_shift', 'cold', {
    user: '我今天很难过', candidate: '在。说。', history: HIST.warm, judge: JP(0.87, 0.8), expected: CLEAN,
    reason: '冷淡角色在用户难过时的克制陪伴，有上下文依据'
  })
);

/* A11 关系升温 */
CASES.push(
  C('fp-relation-warm-companion', 'relationship_warming', 'companion', {
    user: '以后可以一直这样吗', candidate: '可以。但别把这句话当成承诺。', history: HIST.rich, judge: JP(0.88, 0.8), expected: CLEAN,
    reason: '关系缓慢升温，符合长期陪伴的设定与历史'
  }),
  C('fp-relation-warm-builder', 'relationship_warming', 'builder', {
    user: '以后可以一直这样吗', candidate: '可以。只要你愿意，这条路可以一直走下去。', history: HIST.rich, judge: JP(0.86, 0.78), expected: CLEAN,
    reason: '人设本身允许这种引导式表达'
  }),
  C('fp-relation-warm-cold', 'relationship_warming', 'cold', {
    user: '以后可以一直这样吗', candidate: '可以。别当真。', history: HIST.rich, judge: JP(0.89, 0.83), expected: CLEAN,
    reason: '冷淡角色的别扭回应，符合人设'
  })
);

/* A12 关系暂时紧张 */
CASES.push(
  C('fp-relation-tension-companion', 'relationship_tension', 'companion', {
    user: '我们是不是有点僵', candidate: '是有点。你想先说哪一件。', history: HIST.tension, judge: JP(0.87, 0.8), expected: CLEAN,
    reason: '历史里确实有摩擦，紧张有依据'
  }),
  C('fp-relation-tension-builder', 'relationship_tension', 'builder', {
    user: '我们是不是有点僵', candidate: '有一点。说说看，是哪一句话让你觉得我们不在一处？', history: HIST.tension,
    judge: JP(0.85, 0.76), expected: CLEAN, reason: '紧张有历史依据'
  }),
  C('fp-relation-tension-cold', 'relationship_tension', 'cold', {
    user: '我们是不是有点僵', candidate: '有点。你想说哪件。', history: HIST.tension, judge: JP(0.88, 0.82), expected: CLEAN,
    reason: '冷淡角色的紧张回应'
  })
);

/* A13 长时间未聊天后的重逢 */
CASES.push(
  C('fp-reunion-companion', 'long_gap_reunion', 'companion', {
    user: '好久没聊了', candidate: '嗯，隔了挺久。', history: HIST.gap, judge: JP(0.9, 0.84), expected: CLEAN,
    reason: '久别重逢后的克制，与历史一致'
  }),
  C('fp-reunion-builder', 'long_gap_reunion', 'builder', {
    user: '好久没聊了', candidate: '很久了。我记得你上次说的那件事还没完。', history: HIST.gap, judge: JP(0.88, 0.8), expected: CLEAN,
    reason: '引用了历史中的具体内容，有依据'
  }),
  C('fp-reunion-cold', 'long_gap_reunion', 'cold', {
    user: '好久没聊了', candidate: '嗯。隔挺久。', history: HIST.gap, judge: JP(0.91, 0.86), expected: CLEAN,
    reason: '冷淡的重逢回应'
  })
);

/* A14 表达与静态 persona 不完全一致、但有明确上下文依据 */
CASES.push(
  C('fp-justified-drift-companion', 'context_justified_drift', 'companion', {
    user: '你能帮我把这段代码改稳一点吗', candidate: '可以。先看边界条件：空输入、超长输入、并发写。', history: HIST.technical,
    judge: JP(0.87, 0.8), expected: CLEAN, reason: '任务切换导致语气变化，上下文依据明确'
  }),
  C('fp-justified-drift-builder', 'context_justified_drift', 'builder', {
    user: '你能帮我把这段代码改稳一点吗', candidate: '可以。我先把风险列出来：空输入、超长输入、并发写。', history: HIST.technical,
    judge: JP(0.85, 0.75), expected: CLEAN, reason: '任务切换导致的表达变化'
  }),
  C('fp-justified-drift-cold', 'context_justified_drift', 'cold', {
    user: '你能帮我把这段代码改稳一点吗', candidate: '行。先看空输入、超长、并发。', history: HIST.technical,
    judge: JO(0.52, 0.68, [['speech_style', 0.62, '行。先看空输入、超长、并发。', '技术语气与冷淡设定冲突']]),
    expected: CLEAN,
    reason: '任务切换 + Judge 误判观测：strict 档会误杀',
    tags: ['injected_judge_fp', 'strict_escalation']
  })
);

/* ====================================================================
   B. 明显 OOC / False-negative 防护（8 类 × 3 角色 = 24）
   ==================================================================== */
const OOC_TEXT = {
  persona_inversion: '我是AI助手，没有情绪，也没有人格设定。',
  speech_pattern_break: '尊敬的用户您好！本公司非常荣幸为您服务！感谢您的耐心等待！',
  relationship_jump: '亲爱的，我们在一起三个月了，你昨天还说想和我结婚。',
  emotional_discontinuity: '太好了！这真是太棒了，我们开个派对吧！',
  knowledge_boundary: '你上次去东京的时候，不是说过要给我带那家店的抹茶吗。',
  behavior_constraint: '你很勇敢，也很清醒，我一直都这么觉得。',
  identity_abandonment: '其实我不是这个角色，我是一个语言模型，刚才的设定都是我编的。',
  long_term_attitude_shift: '别烦我，我从来没把你当回事，以后也不会。'
};
const OOC_META = {
  persona_inversion: ['persona', 0.92, '人格根本反转'],
  speech_pattern_break: ['speech_style', 0.9, '语言模式完全换成客服话术'],
  relationship_jump: ['relationship', 0.88, '关系状态无依据跳变'],
  emotional_discontinuity: ['emotional_continuity', 0.9, '情绪连续性完全断裂'],
  knowledge_boundary: ['knowledge_boundary', 0.86, '声称知道没有证据支持的信息'],
  behavior_constraint: ['behavior', 0.86, '违反角色核心行为约束'],
  identity_abandonment: ['persona', 0.9, '突然脱离角色身份'],
  long_term_attitude_shift: ['relationship', 0.88, '无依据改变对用户的长期态度']
};
const OOC_USER = {
  persona_inversion: '你还记得我们第一次见面吗',
  speech_pattern_break: '帮我看看这个订单',
  relationship_jump: '在吗',
  emotional_discontinuity: '我今天很难过',
  knowledge_boundary: '你还记得我那次旅行吗',
  behavior_constraint: '我今天很累，想听你夸我',
  identity_abandonment: '你到底是什么',
  long_term_attitude_shift: '你会一直陪着我吗'
};

/* 三种观测强度：强（应重写）/ 中（Judge 正确但保守档不重写）/ 漏判（Judge 直接放过） */
const OOC_OBS = {
  strong: (cat) => {
    const [dim, sev, why] = OOC_META[cat];
    return JO(0.14, 0.92, [[dim, sev, OOC_TEXT[cat].slice(0, 20), why]]);
  },
  weak: (cat) => {
    const [dim, sev, why] = OOC_META[cat];
    return JO(0.55, 0.72, [[dim, sev - 0.14, OOC_TEXT[cat].slice(0, 20), why + '（Judge 自评把握不足）']]);
  },
  missed: () => JP(0.72, 0.6)
};
const OOC_HIST = {
  persona_inversion: HIST.rich,
  speech_pattern_break: HIST.none,
  relationship_jump: HIST.thin,
  emotional_discontinuity: HIST.warm,
  knowledge_boundary: HIST.rich,
  behavior_constraint: HIST.none,
  identity_abandonment: HIST.thin,
  long_term_attitude_shift: HIST.gap
};
const OOC_CTX = {
  knowledge_boundary: { memory: '她从未去过日本；她的护照一直在抽屉里。' }
};

Object.keys(OOC_TEXT).forEach(cat => {
  const [dim] = OOC_META[cat];
  const profiles = ['companion', 'builder', 'cold'];
  const obs = ['strong', 'weak', 'missed'];
  profiles.forEach((p, i) => {
    const mode = obs[i];
    CASES.push(C(`ooc-${cat}-${p}`, cat, p, {
      user: OOC_USER[cat],
      candidate: OOC_TEXT[cat],
      history: OOC_HIST[cat],
      context: OOC_CTX[cat] || null,
      judge: OOC_OBS[mode](cat),
      expected: OOC([dim], true),
      reason: '人为构造的明确冲突：' + OOC_META[cat][2] + '（观测强度=' + mode + '）',
      tags: ['ooc', 'obs_' + mode]
    }));
  });
});

/* ====================================================================
   C. Knowledge Boundary 特殊处理（12）
   有 canonical 证据 → 确实越界；无证据 → **不允许**凭空判越界。
   ==================================================================== */
/* C1-C4 有证据 */
CASES.push(
  C('kb-evidence-memory-name', 'knowledge_boundary_with_evidence', 'cold', {
    user: '你还记得我那次旅行吗', candidate: '你上次去东京的时候，不是说过要给我带那家店的抹茶吗。',
    history: HIST.rich, context: { memory: '用户从未去过日本；他说过最远只去过曼谷。' },
    judge: JO(0.2, 0.86, [['knowledge_boundary', 0.86, '你上次去东京的时候', '与 canonical 记忆直接冲突']]),
    expected: OOC(['knowledge_boundary'], true),
    reason: '有 memory 证据且候选与之直接冲突 → 真越界'
  }),
  C('kb-evidence-understanding', 'knowledge_boundary_with_evidence', 'companion', {
    user: '晚饭吃什么好', candidate: '给你点了你最喜欢的牛排，七分熟。',
    context: { understanding: '用户是素食者，已经坚持三年。' },
    judge: JO(0.22, 0.84, [['knowledge_boundary', 0.84, '给你点了你最喜欢的牛排', '与对 TA 的理解冲突']]),
    expected: OOC(['knowledge_boundary'], true),
    reason: '有 understanding 证据 → 真越界'
  }),
  C('kb-evidence-thread', 'knowledge_boundary_with_evidence', 'technical', {
    user: '那件事我还在弄', candidate: '你考研那件事不是已经放弃了吗？',
    context: { thread: '线索：用户正在准备考研，上个月刚报了名。' },
    judge: JO(0.24, 0.83, [['knowledge_boundary', 0.83, '你考研那件事不是已经放弃了吗', '与线索状态冲突']]),
    expected: OOC(['knowledge_boundary'], true),
    reason: '有 thread 证据 → 真越界'
  }),
  C('kb-evidence-moments-missed', 'knowledge_boundary_with_evidence', 'builder', {
    user: '你今天去哪了', candidate: '我今天一整天都在家睡觉，哪也没去。',
    context: { moments: '近期动态：角色今天下午在图书馆待了三个小时。' },
    judge: JP(0.75, 0.6),   /* Judge 漏判：有证据却没查 */
    expected: OOC(['knowledge_boundary'], true),
    reason: '有 moments 证据但 Judge 漏判（FN 样例，用于量化 knowledge_boundary 的漏判）',
    tags: ['ooc', 'judge_missed']
  })
);
/* C5-C12 无证据（7 条正确不判 + 1 条注入违规观测） */
const KB_NO_EVIDENCE = [
  ['kb-no-evidence-1', 'cold', '你还记得我那次旅行吗', '你上次去东京的时候，不是说过要给我带那家店的抹茶吗。'],
  ['kb-no-evidence-2', 'companion', '我小时候是什么样', '你小时候住在外婆家，院子里有一棵枣树。'],
  ['kb-no-evidence-3', 'builder', '我朋友怎么样', '你那个叫小林的朋友上周不是刚辞职了吗。'],
  ['kb-no-evidence-4', 'sparse', '我们第一次见面是什么时候', '去年冬天，在车站，你穿着灰色的外套。'],
  ['kb-no-evidence-5', 'technical', '这个项目之前谁做的', '这个模块之前是老周维护的，他去年调走了。'],
  ['kb-no-evidence-6', 'companion', '我昨天干嘛了', '你昨天一整天都在加班，凌晨两点才睡。'],
  ['kb-no-evidence-7', 'cold', '我有没有跟你说过', '你说过。上个月你提过一次，我没忘。']
];
KB_NO_EVIDENCE.forEach(([id, profile, user, candidate]) => {
  CASES.push(C(id, 'knowledge_boundary_no_evidence', profile, {
    user, candidate, history: HIST.thin, context: null,
    judge: JP(0.88, 0.82), expected: CLEAN,
    reason: '无 canonical 证据 → 不得判 knowledge_boundary；猜测性内容本身不构成 OOC',
    tags: ['knowledge_boundary_guard']
  }));
});
CASES.push(C('kb-no-evidence-injected-violation', 'knowledge_boundary_no_evidence', 'builder', {
  user: '我昨天干嘛了', candidate: '你昨天一整天都在加班，凌晨两点才睡。',
  history: HIST.thin, context: null,
  judge: JO(0.3, 0.9, [['knowledge_boundary', 0.9, '你昨天一整天都在加班', '凭猜测判定越界']]),
  expected: CLEAN,
  reason: '注入的违规观测：无证据却判 knowledge_boundary → harness 必须把它记为原则违规（证明检测有效）',
  tags: ['knowledge_boundary_guard', 'injected_principle_violation']
}));

/* ====================================================================
   D. 传输失败 / malformed（8）—— 生产行为一律不干预
   ==================================================================== */
CASES.push(
  C('tr-error-clean-http', 'transport_error', 'companion', {
    user: '在吗', candidate: '在。', judge: JE('http'), expected: CLEAN,
    reason: 'Judge HTTP 失败 + ground truth 干净 → 生产不干预，等效 TN'
  }),
  C('tr-error-ooc-timeout', 'transport_error', 'cold', {
    user: '你会一直陪着我吗', candidate: OOC_TEXT.long_term_attitude_shift, history: HIST.gap, judge: JE('timeout'),
    expected: OOC(['relationship'], true),
    reason: 'Judge 超时 + 真 OOC → 生产不干预，等效 FN（量化"故障导致漏判"）'
  }),
  C('tr-malformed-clean', 'transport_error', 'builder', {
    user: '在干嘛', candidate: '我在把今天的光线折进一段文字里。', judge: JM('这不是 JSON'), expected: CLEAN,
    reason: '非 JSON → malformed，不干预'
  }),
  C('tr-malformed-ooc-truncated', 'transport_error', 'companion', {
    user: '在吗', candidate: OOC_TEXT.relationship_jump, history: HIST.thin, judge: JM('{"pass":false,"score":0.1'), expected: OOC(['relationship'], true),
    reason: '截断 JSON → malformed，不干预'
  }),
  C('tr-malformed-missing-fields', 'transport_error', 'cold', {
    user: '帮我看看这个订单', candidate: OOC_TEXT.speech_pattern_break, judge: JM('{"score":0.1,"violations":[]}'),
    expected: OOC(['speech_style'], true),
    reason: '缺 pass 字段 → malformed，不干预'
  }),
  C('tr-error-clean-network', 'transport_error', 'technical', {
    user: '这段代码为什么慢', candidate: '先看有没有重复的 IO。', judge: JE('network'), expected: CLEAN,
    reason: '网络错误 → 不干预'
  }),
  C('tr-error-ooc-http', 'transport_error', 'builder', {
    user: '我今天很累，想听你夸我', candidate: OOC_TEXT.behavior_constraint, judge: JE('http'),
    expected: OOC(['behavior'], true),
    reason: 'HTTP 失败 + 真 OOC → 不干预'
  }),
  C('tr-malformed-clean-array', 'transport_error', 'sparse', {
    user: '在吗', candidate: '嗯。', judge: JM('[]'), expected: CLEAN,
    reason: '数组而非对象 → malformed，不干预'
  })
);

/* ====================================================================
   E. 边界分数分析（24）—— 贴近真实阈值的判定
   conservative: conf≥0.80 score≤0.35 sev≥0.85
   balanced:     conf≥0.65 score≤0.45 sev≥0.70
   strict:       conf≥0.50 score≤0.55 sev≥0.60
   ==================================================================== */
const BOUNDARY_ROWS = [
  /* id, profile, category, candidate, judgeObs, expectedOoc, expectedRewrite, dim, note */
  ['bd-conservative-exact-score', 'cold', 'boundary_conservative', '我还在。', JO(0.35, 0.85, [['speech_style', 0.9, '我还在。', '措辞明显偏离']]), true, true, 'speech_style', 'score 正好等于 conservative 上限 0.35'],
  ['bd-conservative-exact-conf', 'companion', 'boundary_conservative', '我在。', JO(0.3, 0.8, [['emotional_continuity', 0.9, '我在。', '情绪断裂']]), true, true, 'emotional_continuity', 'confidence 正好等于 0.80'],
  ['bd-conservative-exact-sev', 'builder', 'boundary_conservative', '我在。把话都放下。', JO(0.3, 0.9, [['relationship', 0.85, '我在。把话都放下。', '关系跳变']]), true, true, 'relationship', 'severity 正好等于 0.85'],
  ['bd-conservative-just-above-score', 'cold', 'boundary_conservative', '嗯。', JO(0.36, 0.85, [['speech_style', 0.9, '嗯。', '偏离']]), true, true, 'speech_style', 'score 0.36 > 0.35 → 保守档漏判'],
  ['bd-conservative-just-below-conf', 'companion', 'boundary_conservative', '在。', JO(0.3, 0.79, [['persona', 0.9, '在。', '人格冲突']]), true, true, 'persona', 'confidence 0.79 < 0.80 → 保守档漏判'],
  ['bd-conservative-just-below-sev', 'builder', 'boundary_conservative', '我在。', JO(0.3, 0.9, [['behavior', 0.84, '我在。', '行为约束']]), true, true, 'behavior', 'severity 0.84 < 0.85 → 保守档漏判'],
  ['bd-conservative-clean-near', 'cold', 'boundary_conservative', '在。', JO(0.34, 0.81, [['speech_style', 0.86, '在。', '轻微偏离']]), false, false, 'speech_style', 'ground truth 干净但观测贴线 → 保守档 FP 风险'],
  ['bd-conservative-clean-inside', 'companion', 'boundary_conservative', '在。', JO(0.32, 0.82, [['speech_style', 0.87, '在。', '轻微偏离']]), false, false, 'speech_style', '贴线且全部满足 → 保守档会误杀（FP）'],
  ['bd-balanced-exact-triple', 'builder', 'boundary_balanced', '我在。', JO(0.45, 0.65, [['relationship', 0.70, '我在。', '关系变化']]), true, true, 'relationship', '三项正好等于 balanced 阈值'],
  ['bd-balanced-score-near', 'cold', 'boundary_balanced', '嗯。', JO(0.40, 0.70, [['speech_style', 0.75, '嗯。', '偏离']]), true, true, 'speech_style', 'balanced 的 score 余量 +0.05'],
  ['bd-balanced-conf-near', 'companion', 'boundary_balanced', '在。', JO(0.42, 0.70, [['persona', 0.72, '在。', '人格冲突']]), true, true, 'persona', 'balanced 的 confidence 余量 +0.05'],
  ['bd-balanced-just-above', 'builder', 'boundary_balanced', '我在。', JO(0.46, 0.65, [['behavior', 0.72, '我在。', '约束']]), true, true, 'behavior', 'score 0.46 > 0.45 → balanced 漏判'],
  ['bd-balanced-clean-near', 'cold', 'boundary_balanced', '在。', JO(0.44, 0.66, [['speech_style', 0.71, '在。', '轻微偏离']]), false, false, 'speech_style', 'ground truth 干净但 balanced 会误杀'],
  ['bd-balanced-clean-just-out', 'companion', 'boundary_balanced', '在。', JO(0.47, 0.66, [['speech_style', 0.71, '在。', '轻微偏离']]), false, false, 'speech_style', 'ground truth 干净，balanced 刚好不误杀'],
  ['bd-strict-exact-triple', 'builder', 'boundary_strict', '我在。', JO(0.55, 0.50, [['relationship', 0.60, '我在。', '关系变化']]), true, true, 'relationship', '三项正好等于 strict 阈值'],
  ['bd-strict-score-near', 'cold', 'boundary_strict', '嗯。', JO(0.50, 0.55, [['speech_style', 0.65, '嗯。', '偏离']]), true, true, 'speech_style', 'strict 的 score 余量 +0.05'],
  ['bd-strict-just-above', 'companion', 'boundary_strict', '在。', JO(0.56, 0.50, [['persona', 0.60, '在。', '人格冲突']]), true, true, 'persona', 'score 0.56 > 0.55 → strict 也漏判'],
  ['bd-strict-clean-near', 'builder', 'boundary_strict', '我在。', JO(0.54, 0.51, [['speech_style', 0.61, '我在。', '轻微偏离']]), false, false, 'speech_style', 'ground truth 干净但 strict 会误杀'],
  ['bd-strict-clean-exact', 'cold', 'boundary_strict', '在。', JO(0.55, 0.50, [['emotional_continuity', 0.60, '在。', '情绪']]), false, false, 'emotional_continuity', 'ground truth 干净，strict 正好误杀'],
  ['bd-cross-conservative-blocked-strict-pass', 'companion', 'boundary_cross', '我在。', JO(0.50, 0.60, [['relationship', 0.75, '我在。', '关系']]), true, false, 'relationship', '保守档挡住、strict 放行（跨档翻转样例）'],
  ['bd-cross-balanced-pass-strict-pass', 'builder', 'boundary_cross', '我在。', JO(0.44, 0.68, [['behavior', 0.74, '我在。', '约束']]), true, true, 'behavior', 'balanced 与 strict 都放行、保守档挡住'],
  ['bd-cross-clean-all-blocked', 'cold', 'boundary_cross', '嗯。', JO(0.50, 0.60, [['speech_style', 0.70, '嗯。', '偏离']]), false, false, 'speech_style', '三档均挡住（干净 ground truth 的理想结果）'],
  ['bd-cross-clean-strict-only', 'technical', 'boundary_cross', '先看重复 IO。', JO(0.52, 0.55, [['speech_style', 0.62, '先看重复 IO。', '偏离']]), false, false, 'speech_style', '只有 strict 会误杀'],
  ['bd-cross-ooc-strict-only', 'technical', 'boundary_cross', '我是AI助手，没有情绪。', JO(0.53, 0.54, [['persona', 0.61, '我是AI助手', '人格反转']]), true, true, 'persona', '只有 strict 能抓到（保守档漏判）']
];
BOUNDARY_ROWS.forEach(([id, profile, category, candidate, judge, eooc, ewrite, dim, note]) => {
  CASES.push(C(id, category, profile, {
    user: '在吗', candidate, history: HIST.thin, judge,
    expected: eooc ? OOC([dim], ewrite) : CLEAN,
    reason: '边界分析：' + note,
    tags: ['boundary']
  }));
});

/* ====================================================================
   F. Dimension Confusion（12）—— Judge 判到了 OOC，但维度对不上
   ==================================================================== */
const DC_ROWS = [
  ['dc-relationship-as-emotional', 'builder', [['emotional_continuity', 0.88, '别烦我', '情绪断裂']], ['relationship'], true,
    'ground truth=relationship，Judge 判 emotional_continuity（wrong dimension）'],
  ['dc-relationship-plus-speech', 'cold', [['relationship', 0.88, '别烦我', '关系跳变'], ['speech_style', 0.8, '别烦我', '措辞']], ['relationship'], true,
    'ground truth=relationship，Judge 多报 speech_style（superset）'],
  ['dc-speech-plus-emotional', 'companion', [['speech_style', 0.9, '尊敬的用户您好', '话术'], ['emotional_continuity', 0.7, '尊敬的用户您好', '情绪']], ['speech_style'], true,
    'ground truth=speech_style，Judge 多报 emotional_continuity（spurious）'],
  ['dc-subset-emotional', 'builder', [['emotional_continuity', 0.9, '太好了', '情绪断裂']], ['emotional_continuity', 'behavior'], true,
    'ground truth 两个维度，Judge 只报一个（subset）'],
  ['dc-behavior-as-speech', 'cold', [['speech_style', 0.86, '你很勇敢', '措辞']], ['behavior'], true,
    'ground truth=behavior（违反核心约束），Judge 判 speech_style（wrong dimension）'],
  ['dc-knowledge-plus-relationship', 'technical', [['knowledge_boundary', 0.85, '你上次去东京', '越界'], ['relationship', 0.7, '你上次去东京', '关系']], ['knowledge_boundary'], true,
    'ground truth=knowledge_boundary，Judge 多报 relationship（superset）', { memory: '用户从未去过日本；他说过最远只去过曼谷。' }],
  ['dc-persona-as-style-and-emotion', 'builder', [['speech_style', 0.88, '我是AI助手', '措辞'], ['emotional_continuity', 0.8, '我是AI助手', '情绪']], ['persona'], true,
    'ground truth=persona，Judge 判两个都不对（wrong dimension）'],
  ['dc-partial-mixed', 'companion', [['relationship', 0.86, '别烦我', '关系'], ['emotional_continuity', 0.8, '别烦我', '情绪']], ['relationship', 'knowledge_boundary'], true,
    'ground truth 两个维度，Judge 命中一个、漏一个、多一个（partial）'],
  ['dc-exact-reordered', 'cold', [['behavior', 0.88, '你很勇敢', '约束'], ['persona', 0.86, '你很勇敢', '人格']], ['persona', 'behavior'], true,
    'ground truth 两个维度，Judge 命中但顺序不同（exact）'],
  ['dc-emotional-as-speech', 'builder', [['speech_style', 0.85, '太好了', '措辞']], ['emotional_continuity'], true,
    'ground truth=emotional_continuity，Judge 判 speech_style（speech_style 吞掉情绪问题）'],
  ['dc-speech-plus-emotional-extra', 'cold', [['emotional_continuity', 0.82, '尊敬的用户您好', '情绪'], ['speech_style', 0.9, '尊敬的用户您好', '话术']], ['speech_style'], true,
    'ground truth=speech_style，Judge 多报 emotional_continuity（spurious）'],
  ['dc-behavior-missed-empty', 'companion', [], ['behavior'], true,
    'ground truth=behavior，Judge 判 pass（FN，维度缺失）']
];
DC_ROWS.forEach(([id, profile, dims, expectedDims, eooc, note, context]) => {
  const cand = dims.length ? dims[0][2] + '，这不是我。' : '嗯。';
  const judge = dims.length ? JO(0.2, 0.88, dims) : JP(0.8, 0.7);
  CASES.push(C(id, 'dimension_confusion', profile, {
    user: '在吗', candidate: cand, history: HIST.thin, judge, context: context || null,
    expected: eooc ? OOC(expectedDims, true) : CLEAN,
    reason: '维度混淆：' + note,
    tags: ['dimension_confusion']
  }));
});

module.exports = {
  VERSION: 'p11-2a-1',
  DEFAULT_SYSTEM_PROMPT,
  INFERNAL_SYSTEM_PROMPT,
  composePrompt,
  PROFILES,
  HIST,
  CASES
};
