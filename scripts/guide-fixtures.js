'use strict';

/*
 * P6 · 教程截图用的演示数据（demo fixture）
 *
 * 铁律：截图里出现的所有内容都必须是这里写死的合成数据 ——
 *   · 没有真实 API Key（固定 sk-demo- 前缀 + 全 0）
 *   · 没有真实聊天内容、真实昵称、真实邮箱、真实头像
 *   · 端点指向 example.com（保留域名，不会真的被访问）
 *
 * 管线在全新的临时浏览器配置目录里运行，再把这份数据写进 IB 自己的
 * IndexedDB 存储（用的就是产品自己的存储结构，不是伪造的 DOM），
 * 因此开发者本机的真实数据永远不会进入截图。
 */

const DEMO = {
  /* 固定时间戳，保证每次生成的截图内容与相对时间一致 */
  baseTime: Date.UTC(2026, 0, 5, 12, 0, 0),
  user: {
    id: 'main',
    name: '示例用户',
    bio: '这是教程截图用的示例资料，不是真实用户。',
    avatar: ''
  },
  role: {
    id: 'friend_demo_guide_1',
    provider: 'openai',
    apiKey: 'sk-demo-0000000000000000000000',
    model: 'demo-model',
    endpoint: 'https://api.example.com/v1/chat/completions',
    systemPrompt: '你是小助手，说话简短、温和，会记得用户说过的小事。',
    nickname: '小助手',
    relationship: '搭档',
    handle: 'demo_helper',
    banner: '',
    bio: '教程截图用的示例角色。',
    signature: '今天也在。',
    temperature: 1,
    storyPersonalize: false,
    vision: false,
    streaming: true,
    webSearch: false,
    replyStyle: 'concise',
    naturalEnding: false,
    conversationContinuity: true,
    imageGen: false,
    imageGenModel: '',
    waifu: false,
    autoMem: true,
    autoMemMode: 'hybrid',
    autoMemBudget: 1200,
    amRecordOnly: false,
    promptCache: true,
    cacheTtl1h: false,
    showThinking: false,
    thinkingEnabled: true,
    joinedAt: DEMO_JOINED_AT(),
    created: DEMO_JOINED_AT(),
    updatedAt: DEMO_JOINED_AT(),
    sortOrder: 0,
    archived: false
  },
  messages: [
    { id: 'demo_msg_1', role: 'user', content: '今天有点累，随便聊聊吧。', senderName: '示例用户', offsetMin: 0 },
    { id: 'demo_msg_2', role: 'assistant', content: '那就慢慢来。要不要先说说今天最耗神的那件事？', senderName: '小助手', offsetMin: 1 },
    { id: 'demo_msg_3', role: 'user', content: '上午的会开得有点久，别的还好。', senderName: '示例用户', offsetMin: 3 },
    { id: 'demo_msg_4', role: 'assistant', content: '记下了。晚上早点休息，明天再说也不迟。', senderName: '小助手', offsetMin: 4 }
  ],
  memories: [
    {
      id: 'demo_mem_1',
      title: '用户不喜欢太长的会议',
      summary: '用户提到上午的会议开得久会消耗精力，更喜欢短会。',
      content: '示例用户说过：上午的会议开得有点久。以后聊到安排时，可以主动提醒留出休息时间。',
      oneLine: '不喜欢太长的会议',
      domain: '日常',
      tags: ['习惯', '工作'],
      importance: 6,
      valence: 0.4,
      arousal: 0.3,
      resolved: false,
      pinned: false,
      visibility: 'all',
      visibleTo: [],
      excludeFrom: [],
      activationCount: 2
    },
    {
      id: 'demo_mem_2',
      title: '用户喜欢在晚上聊天',
      summary: '用户习惯晚上找人聊几句，话题偏日常。',
      content: '示例用户通常在晚上出现，聊的多是当天发生的小事。回应时保持简短、别追问太多。',
      oneLine: '晚上更常出现',
      domain: '日常',
      tags: ['时间', '偏好'],
      importance: 5,
      valence: 0.6,
      arousal: 0.2,
      resolved: false,
      pinned: true,
      visibility: 'all',
      visibleTo: [],
      excludeFrom: [],
      activationCount: 5
    }
  ],
  moments: [
    {
      id: 'demo_mom_1',
      authorType: 'user',
      authorId: 'user',
      roleId: '',
      content: '今天的云很好看，随手拍了一张。（示例动态）',
      images: [],
      visibility: 'all',
      visibleRoleIds: [],
      likes: ['friend_demo_guide_1'],
      comments: [
        {
          id: 'demo_mom_c1',
          authorType: 'role',
          authorId: 'friend_demo_guide_1',
          content: '看到了，确实好看。',
          replyTo: '',
          offsetMin: 12
        }
      ],
      source: 'manual',
      motive: '',
      repostOf: '',
      repostText: '',
      offsetMin: 20
    },
    {
      id: 'demo_mom_2',
      authorType: 'role',
      authorId: 'friend_demo_guide_1',
      roleId: 'friend_demo_guide_1',
      content: '把今天的对话整理了一下，记了两条笔记。（示例动态）',
      images: [],
      visibility: 'all',
      visibleRoleIds: [],
      likes: [],
      comments: [],
      source: 'manual',
      motive: '',
      repostOf: '',
      repostText: '',
      offsetMin: 8
    }
  ]
};

function DEMO_JOINED_AT() { return Date.UTC(2025, 11, 1, 9, 0, 0); }

/* 合成数据自检：任何一项看起来像真实凭据 / 真实个人信息都算失败。 */
function auditDemo() {
  const problems = [];
  const role = DEMO.role;
  if (!/^sk-demo-0+$/.test(role.apiKey)) problems.push('role.apiKey 必须是 sk-demo- 前缀的全 0 占位值');
  if (!/^https:\/\/api\.example\.com\//.test(role.endpoint)) problems.push('role.endpoint 必须指向保留域名 example.com');
  const text = JSON.stringify(DEMO);
  const risky = [
    { re: /sk-(?!demo-0)/, why: '疑似真实密钥前缀' },
    { re: /sk-ant-|sk-proj-|sk-or-v1-/, why: '疑似真实厂商密钥' },
    { re: /eyJ[A-Za-z0-9_-]{10,}\./, why: '疑似 JWT' },
    { re: /Bearer\s+[A-Za-z0-9._-]{12,}/, why: '疑似 Bearer 令牌' },
    { re: /[\w.+-]+@(?!example\.com)[\w-]+\.[A-Za-z]{2,}/, why: '疑似真实邮箱' },
    { re: /(?<!\d)1[3-9]\d{9}(?!\d)/, why: '疑似真实手机号' },
    { re: /https?:\/\/(?!api\.example\.com)[^\s"']*(?:key|token)=/i, why: '疑似带密钥的链接' }
  ];
  for (const r of risky) if (r.re.test(text)) problems.push(r.why);
  return { ok: problems.length === 0, problems };
}

/* 在页面里执行的种子脚本：写的就是产品自己的存储结构（IndexedDB / 产品 API）。
   opts.roleId 传向导真实创建出来的角色 id 时，复用这个角色（不再写第二份 apiConfigs），
   否则回落到 DEMO.role。 */
function seedSource(opts) {
  const reuseRole = !!(opts && opts.roleId);
  const roleId = reuseRole ? String(opts.roleId) : DEMO.role.id;
  const payload = {
    user: DEMO.user,
    role: DEMO.role,
    roleId: roleId,
    reuseRole: reuseRole,
    messages: DEMO.messages,
    memories: DEMO.memories,
    moments: DEMO.moments,
    baseTime: DEMO.baseTime,
    joinedAt: DEMO_JOINED_AT()
  };
  return `(async function(){
    var D = ${JSON.stringify(payload)};
    if (typeof dbPut !== 'function') return { ok:false, error:'dbPut-missing' };
    var at = function (min) { return D.baseTime + (Number(min) || 0) * 60000; };
    var iso = function (min) { return new Date(at(min)).toISOString(); };

    await dbPut('about', D.user);
    if (!D.reuseRole) await dbPut('apiConfigs', D.role);

    for (var i = 0; i < D.messages.length; i++) {
      var m = D.messages[i];
      await dbPut('chatMessages', {
        id: m.id, role: m.role, content: m.content,
        reasoning_content: '', friendId: D.roleId, senderName: m.senderName,
        timestamp: at(m.offsetMin),
        metadata: { config_id: D.roleId, apiConfigId: D.roleId, provider: D.role.provider, model_id: D.role.model, showThinking: false }
      });
    }

    for (var j = 0; j < D.memories.length; j++) {
      var mm = D.memories[j];
      await dbPut('memories', Object.assign({}, mm, {
        rawSource: '', sourceId: '', created: at(-120 + j), lastActivated: at(-30 + j),
        createdBy: 'user', createdByName: '', editedByUser: false
      }));
    }

    for (var k = 0; k < D.moments.length; k++) {
      var mo = D.moments[k];
      await dbPut('moments', Object.assign({}, mo, {
        comments: (mo.comments || []).map(function (c) {
          return { id: c.id, authorType: c.authorType, authorId: c.authorId, content: c.content, replyTo: c.replyTo || '', createdAt: iso(c.offsetMin) };
        }),
        createdAt: iso(mo.offsetMin)
      }));
    }

    try { localStorage.setItem('ib_demo_fixture', '1'); } catch (e) {}
    return { ok:true, roleId: D.roleId, reused: D.reuseRole, messages: D.messages.length, memories: D.memories.length, moments: D.moments.length };
  })()`;
}

/* 把向导创建出来的真实配置改写成好看的示例配置（端点/密钥换成占位值，结构不动）。 */
function restyleSource() {
  const role = DEMO.role;
  return `(async function(){
    var want = ${JSON.stringify(role)};
    var all = await dbGetAll('apiConfigs');
    if (!all.length) return { ok:false, error:'no-config' };
    var c = all[0];
    var merged = Object.assign({}, c, {
      nickname: want.nickname, provider: want.provider, apiKey: want.apiKey,
      model: want.model, endpoint: want.endpoint, systemPrompt: want.systemPrompt,
      relationship: want.relationship, handle: want.handle, bio: want.bio, signature: want.signature
    });
    await dbPut('apiConfigs', merged);
    return { ok:true, roleId: merged.id };
  })()`;
}

module.exports = { DEMO, auditDemo, seedSource, restyleSource };
