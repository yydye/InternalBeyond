/* Internal Beyond — P6 · 零基础使用指南（Zero-Beginner Guide）
 *
 * 定位：给第一次接触 IB、甚至从未配置过 AI 接口的普通用户看。
 *   · 只讲「点哪里、填什么、看到什么」，不讲实现细节；
 *   · 正文里不出现底层术语（本文件内做静态断言，见 test_guide.js）；
 *   · 图片只是辅助：加载失败时正文步骤仍然完整可操作；
 *   · 截图文件与正文解耦，由 scripts/capture-guide-shots.js 批量重生成，
 *     清单在 docs/guide/annotations.json（同一份清单也标注指南版本）。
 *
 * 复用而非重建：本模块只往既有 #page-guide 里追加一个章节容器，
 * 不新建第二套帮助页、不接管导航、不改任何产品行为。
 */
(function () {
  'use strict';

  var NS = (window.IBGuide = window.IBGuide || {});

  var HOST_ID = 'guide-beginner';
  var STYLE_ID = 'ib-guide-style';
  var STYLE_HREF = 'assets/css/guide-beginner.css';
  var SHOT_DIR = 'docs/guide/shots/';

  /* 指南版本：默认值与 docs/guide/annotations.json 的 guideVersion 一致（测试断言两者相同）。
     真实产品版本来自单一版本源 VERSION：由启动器附加在地址栏（?ibv=x.y.z），
     或由宿主定义 window.IB_GUIDE_VERSION 注入。两者都没有时使用指南内容版本——
     版本标识永远不发起网络请求，也不影响阅读与操作。 */
  var VERSION_FALLBACK = '1.0';

  function versionFromUrl() {
    try {
      var m = /[?&]ibv=([^&]+)/.exec(String(location.search || ''));
      if (m) {
        var v = decodeURIComponent(m[1]).trim();
        if (/^\d+\.\d+\.\d+$/.test(v)) return v;
      }
    } catch (e) { /* 地址栏不可读时静默回退 */ }
    return '';
  }

  function version() {
    var v = '';
    try { v = String(window.IB_GUIDE_VERSION || '').trim(); } catch (e) { v = ''; }
    if (!v) v = versionFromUrl();
    return v || VERSION_FALLBACK;
  }

  /* ══ 章节数据 ═══════════════════════════════════════════════
     每章：一句目标 + 截图（0–4 张）+ 1–4 个步骤 + 可选「遇到问题？」
     shot 的 id 必须能在 docs/guide/annotations.json 中找到同名条目。 */
  var CHAPTERS = [
    {
      id: 'welcome',
      title: '欢迎使用 InternalBeyond',
      goal: '先花一分钟认识这个页面：它是什么、你的东西存在哪里、下一步该点哪个按钮。',
      shots: [{ id: '01-welcome', caption: '第一次打开 IB 时看到的欢迎页' }],
      steps: [
        '打开 InternalBeyond 后，你会先看到欢迎页。页面上有三个按钮：「游戏引导」「开始设置」「查看说明」。',
        '第一次使用，请点「开始设置」。它会带你一步步把 AI 配好，大约三分钟。',
        '想先看看再配置，就点底部的「跳过，直接探索」；之后随时可以回来重新设置。'
      ],
      tip: {
        title: '遇到问题？',
        text: '你的聊天、记忆、信件等内容都保存在你自己的这台电脑上，不会自动上传到别的地方。想留个备份，用右上角的 Export 导出一份存档文件即可。'
      }
    },
    {
      id: 'setup',
      title: '第一次设置',
      goal: '跟着设置向导走完 7 步，IB 就能开始和你对话了。',
      shots: [
        { id: '02-provider', caption: '向导第 2 步：选择你正在使用的 AI 服务' },
        { id: '03-api-key', caption: '向导第 3 步：填入 API Key（输入框默认只显示圆点）' }
      ],
      steps: [
        '第一次打开 IB 时，设置向导会自动出现。它会带你走完 7 步：欢迎 → 选择 AI 服务 → 填写 API Key → 模型与接口 → 测试连接 → 创建角色 → 设置完成。',
        '在第 2 步选中你正在使用的 AI 服务。不确定选哪个也没关系，选错了可以随时回来改。',
        '在第 3 步把 API Key 填进去。输入框默认只显示圆点，点右侧的小眼睛可以临时查看。',
        '后面几步按提示走即可。任何一步关掉都不用重来：下次打开会从上次停下的地方继续。'
      ],
      tip: {
        title: '已经跳过了向导？',
        text: '打开左侧导航的「API」，页面顶部有「重新运行设置向导」按钮；聊天页在没有角色时也会显示「开始设置」。点任何一个都能重新进入向导。'
      },
      action: { label: '打开 API 设置', page: 'api' }
    },
    {
      id: 'ai',
      title: '添加 / 配置 AI',
      goal: '让 IB 连上你选择的 AI 服务，并确认连接是通的。',
      shots: [
        { id: '04-test-ok', caption: '向导第 5 步：点「测试连接」，看到成功的提示' },
        { id: '08-api-entry', caption: 'API 设置页：右上角「+ 添加API」，顶部是「重新运行设置向导」' }
      ],
      steps: [
        '打开左侧导航的「API」。',
        '点「+ 添加API」，选择你使用的 AI 服务。',
        '把 API Key 填进对应的输入框。请在你所使用的 AI 服务官方网站获取它。',
        '点「测试连接」。看到成功提示就说明配置没问题，再点保存即可。'
      ],
      tip: {
        title: '关于 API Key 的安全',
        text: 'API Key 是 AI 服务发给你的访问密钥，相当于一把钥匙：不要发给别人，也不要发到群里；截图给别人看之前，先把它遮住；本指南和导出的诊断报告都不会包含它。'
      },
      action: { label: '打开 API 设置', page: 'api' }
    },
    {
      id: 'role',
      title: '创建角色',
      goal: '给这个 AI 起个名字、写一句性格设定，它就成为聊天列表里的一个「好友」。',
      shots: [
        { id: '05-role', caption: '向导第 6 步：填写角色昵称与说话方式' },
        { id: '06-done', caption: '向导第 7 步：设置完成，点「开始聊天」' }
      ],
      steps: [
        '在向导最后一步填写角色昵称，例如「小助手」。',
        '想让它更有个性，可以在系统提示词里写一句，例如「说话简短、温和，偶尔用颜文字」。留空也没关系。',
        '点「创建角色」，再点「开始聊天」，向导就结束了。'
      ],
      tip: {
        title: '想再加一个角色？',
        text: '回到「API」→「+ 添加API」，再配一个即可。同一个 AI 服务也可以配成两个角色，只要昵称不同、提示词不同，它们就是两个性格不同的好友。'
      }
    },
    {
      id: 'chat',
      title: '开始聊天',
      goal: '发出第一条消息，并知道在哪里看回复。',
      shots: [{ id: '07-chat', caption: 'Chat 页：左侧是好友列表，底部是输入框与发送按钮' }],
      steps: [
        '打开左侧导航的「Chat」。',
        '在左侧「好友列表」里点一个角色。',
        '在底部输入框里打字，按回车或点右边的发送按钮。',
        '回复会显示在中间。回复一个字一个字出现是正常的，需要时可以在输入框旁边点停止。'
      ],
      tip: {
        title: '遇到问题？',
        text: '如果发出去一直没有回复，先看是不是网络断了；还是不行就打开「Diagnostics」，点「重新检查」，它会告诉你哪一项出了问题。'
      },
      action: { label: '打开聊天页', page: 'chat' }
    },
    {
      id: 'memory',
      title: 'Memory（记忆库）',
      goal: '让 TA 记住你们聊过的事，下次接着聊。',
      shots: [{ id: '09-memory', caption: 'Memory 页：共同记忆的列表与统计' }],
      steps: [
        '打开左侧导航的「Memory」。',
        '这里会列出已经保存下来的共同记忆。点一条可以查看内容。',
        '想把刚才那段对话存成记忆，回到「Chat」，点输入框上方的「Save Memory」，AI 会把最近的对话整理成一条记忆。',
        '记忆太多会占用对话空间，可以在「API」页的记忆设置里调整 AI 一次能读到多少。'
      ],
      tip: {
        title: '关于隐私',
        text: '记忆只存在你自己的电脑上。删除一条记忆，它就彻底没有了。'
      },
      action: { label: '打开 Memory', page: 'memory' }
    },
    {
      id: 'active',
      title: '主动消息',
      goal: '让角色在你没说话的时候，也能主动来找你。',
      shots: [{ id: '10-active', caption: 'Active 页：打开「允许角色主动联系」并设置频率' }],
      steps: [
        '打开左侧导航的「Active」。',
        '打开「允许角色主动联系」。',
        '在「主动规划方式」里选「AI 根据聊天规划」，它会在每次聊完之后判断要不要再来找你。',
        '设置最短间隔和免打扰时间段，然后点「保存设置」。'
      ],
      tip: {
        title: '遇到问题？',
        text: '主动消息需要本地增强功能在线。如果页面提示「后台功能暂时不可用」，去「Diagnostics」看「后台主动功能」那一行，能修就点「尝试修复」。'
      },
      action: { label: '打开 Active', page: 'active' }
    },
    {
      id: 'moments',
      title: '朋友圈 / 动态',
      goal: '像刷朋友圈一样，看角色们发的动态，也可以自己发一条。',
      shots: [{ id: '11-moments', caption: 'Moments 页：社交圈动态流与发布框' }],
      steps: [
        '打开左侧导航的「Moments」。',
        '在顶部「社交圈」的发布框里写点什么，点发布。',
        '角色会给你的动态点赞或评论，它们之间也会互相互动。',
        '想调整互动频率、谁可以发帖，点右上角的「朋友圈设置」。'
      ],
      action: { label: '打开 Moments', page: 'moments' }
    },
    {
      id: 'voice',
      title: '语音',
      goal: '用说话代替打字，或者直接和角色打电话。',
      shots: [{ id: '12-voice', caption: 'Chat 页右上角的电话按钮：发起语音通话' }],
      steps: [
        '发语音消息：在 Chat 里点输入框右边的麦克风按钮开始录音，再点一次就发送。',
        '语音通话：在 Chat 里选中一个角色，点右上角的电话按钮。',
        '通话中也可以打开视频预览，让 TA 看到画面。'
      ],
      tip: {
        title: '遇到问题？',
        text: '语音通话需要本地语音功能在线。如果提示「语音生成失败」，文字聊天不受影响；想恢复语音，去「Diagnostics」看「语音功能」那一行。'
      },
      action: { label: '打开聊天页', page: 'chat' }
    },
    {
      id: 'more',
      title: '其他主要功能',
      goal: '一句话认识剩下的入口，用到再回来查。',
      shots: [],
      steps: [
        '「Blog」是日志：写长文、给日志配图，角色可以来评论。',
        '「Letters」是信件：TA 会隔一段时间给你写一封信。',
        '「Diary」是 AI 日记：TA 会记下自己的日常。',
        '「Room」「Music」「Calendar」「ICode」「DIY」「Favorites」「Apps」分别在左侧导航或页面角落：房间互动、音乐播放、日历、文件工作区、创意工坊、收藏夹与应用。'
      ],
      tip: {
        title: '不想看这么多？',
        text: '平时只用「Chat」也完全可以。其余功能都是可选的，随时可以不用。'
      }
    },
    {
      id: 'diagnostics',
      title: '系统诊断与故障恢复',
      goal: '某个功能不好用时，用这一个页面就能看懂问题、尝试修复、导出报告。',
      shots: [
        { id: '13-diagnostics-ok', caption: '一切正常时，Diagnostics 顶部会写「系统运行正常」' },
        { id: '14-diagnostics-degraded', caption: '部分功能不可用时，会写清哪一项出了问题' },
        { id: '15-repair', caption: '可以修复的问题会出现「尝试修复」按钮' },
        { id: '16-export', caption: '修不好就点「导出诊断报告」，把文件发给维护者' }
      ],
      steps: [
        '打开左侧导航的「Diagnostics」。页面会自动检查一遍，先看最上面那行大字：正常、需要注意，还是部分功能不可用。',
        '再看下面每一行分别是什么状态。点「重新检查」可以随时重新检查一次。',
        '如果某一项显示「不可用」且出现「尝试修复」，点它，等它自己修完。',
        '还是没解决，就点「导出诊断报告」，把生成的文件发给帮你的人。'
      ],
      tip: {
        title: '不需要懂技术',
        text: '大多数情况下，你不需要打开任何命令窗口或开发者工具，也不需要自己去查什么东西。诊断页会把能自动修的先修掉，修不了的会告诉你下一步怎么做。'
      },
      action: { label: '打开 Diagnostics', page: 'diagnostics' }
    },
    {
      id: 'faq',
      title: '常见问题',
      goal: '遇到提示时，先在这里找对应的一条。',
      shots: [],
      items: [
        { q: '提示「API 密钥无法使用」', a: '多半是密钥没复制完整、多了空格，或者已经过期。打开「API」页，重新粘贴一次密钥，点「测试连接」确认。' },
        { q: '提示「AI 服务暂时拒绝了请求」', a: '通常是短时间请求太多，或账户额度受限。等一会儿再试；一直出现就去服务商那里看看余额和用量。' },
        { q: '提示「连接不上网络」', a: '检查这台电脑能不能正常上网。如果开着代理或安全软件，先关掉再试一次。' },
        { q: '提示「当前模型不可用」', a: '打开「API」页，把模型名称改成服务商支持的其中一个，或换一个 AI 服务。' },
        { q: '提示「部分本地功能暂时不可用」，但还能聊天', a: '这表示只有一部分增强功能没在运行，聊天不受影响。打开「Diagnostics」，点「尝试修复」。' },
        { q: '主动消息一直不来', a: '先确认「Active」页里「允许角色主动联系」是打开的；再看「Diagnostics」的「后台主动功能」那一行，必要时点「尝试修复」。' },
        { q: '语音发不出声 / 提示「语音生成失败」', a: '文字聊天不受影响。打开「Diagnostics」看「语音功能」那一行；语音需要本地语音功能在线。' },
        { q: '我跳过了第一次设置，怎么重新设置？', a: '打开「API」页，点「重新运行设置向导」；或者在还没有角色时，点聊天页上的「开始设置」。' },
        { q: '怎么把问题反馈给别人？', a: '打开「Diagnostics」，点「导出诊断报告」，会生成一个文本文件。它不包含你的密钥和聊天内容，可以直接发出去。' },
        { q: '怎么再加一个角色？', a: '打开「API」页，点「+ 添加API」，按向导配一遍即可。多个角色可以共用同一个 AI 服务。' }
      ]
    }
  ];

  /* ══ DOM 工具 ══════════════════════════════════════════════ */

  function byId(id) { return document.getElementById(id); }

  function injectStyles() {
    if (byId(STYLE_ID)) return;
    var link = document.createElement('link');
    link.id = STYLE_ID;
    link.rel = 'stylesheet';
    link.href = STYLE_HREF;
    document.head.appendChild(link);
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  /* 图片只是辅助：失败时换成一行说明，步骤照旧可读（正文与截图解耦）。 */
  function figure(shot) {
    var fig = el('figure', 'gb-figure');
    fig.setAttribute('data-guide-shot', shot.id);

    var img = document.createElement('img');
    img.className = 'gb-shot';
    img.src = SHOT_DIR + shot.id + '.png';
    img.alt = shot.caption || ('示意图：' + shot.id);
    img.loading = 'lazy';
    img.decoding = 'async';
    fig.appendChild(img);

    var cap = el('figcaption', 'gb-caption', shot.caption || '');
    fig.appendChild(cap);

    var miss = el('p', 'gb-shot-missing', '这张图暂时打不开，不影响下面的文字步骤。');
    miss.hidden = true;
    fig.appendChild(miss);

    img.addEventListener('error', function () {
      img.hidden = true;
      miss.hidden = false;
      fig.classList.add('is-missing');
    });
    return fig;
  }

  function actionButton(action) {
    if (!action || !action.page) return null;
    if (!byId('page-' + action.page)) return null;
    var btn = el('button', 'btn gb-action', action.label);
    btn.type = 'button';
    btn.addEventListener('click', function () {
      if (typeof window.navTo === 'function') window.navTo(action.page);
    });
    return btn;
  }

  function renderChapter(ch, index) {
    var sec = el('section', 'gb-chapter');
    sec.id = 'gb-' + ch.id;
    sec.setAttribute('data-guide-chapter', ch.id);

    var head = el('div', 'gb-chapter-head');
    var num = el('span', 'gb-num', String(index + 1));
    num.setAttribute('aria-hidden', 'true');
    head.appendChild(num);
    head.appendChild(el('h3', 'gb-chapter-title', ch.title));
    sec.appendChild(head);

    if (ch.goal) sec.appendChild(el('p', 'gb-goal', ch.goal));

    if (ch.shots && ch.shots.length) {
      var shots = el('div', 'gb-shots');
      for (var i = 0; i < ch.shots.length; i++) shots.appendChild(figure(ch.shots[i]));
      sec.appendChild(shots);
    }

    if (ch.steps && ch.steps.length) {
      var ol = el('ol', 'gb-steps');
      for (var s = 0; s < ch.steps.length; s++) ol.appendChild(el('li', null, ch.steps[s]));
      sec.appendChild(ol);
    }

    if (ch.items && ch.items.length) {
      var dl = el('dl', 'gb-faq');
      for (var q = 0; q < ch.items.length; q++) {
        dl.appendChild(el('dt', 'gb-faq-q', ch.items[q].q));
        dl.appendChild(el('dd', 'gb-faq-a', ch.items[q].a));
      }
      sec.appendChild(dl);
    }

    if (ch.tip) {
      var tip = el('div', 'gb-tip');
      tip.appendChild(el('b', 'gb-tip-title', ch.tip.title || '提示'));
      tip.appendChild(el('span', 'gb-tip-text', ch.tip.text || ''));
      sec.appendChild(tip);
    }

    var btn = actionButton(ch.action);
    if (btn) {
      var wrap = el('p', 'gb-action-row');
      wrap.appendChild(btn);
      sec.appendChild(wrap);
    }
    return sec;
  }

  function buildIndex() {
    var nav = el('nav', 'gb-index');
    nav.setAttribute('aria-label', '零基础使用指南目录');
    nav.appendChild(el('div', 'gb-index-title', '这一页包含'));
    var list = el('ol', 'gb-index-list');
    for (var i = 0; i < CHAPTERS.length; i++) {
      var li = el('li', 'gb-index-item');
      var a = document.createElement('a');
      a.className = 'gb-index-link';
      a.href = '#gb-' + CHAPTERS[i].id;
      a.textContent = CHAPTERS[i].title;
      li.appendChild(a);
      list.appendChild(li);
    }
    nav.appendChild(list);
    return nav;
  }

  function buildTechNote() {
    var det = document.createElement('details');
    det.className = 'gb-tech';
    var sum = document.createElement('summary');
    sum.textContent = '技术说明（可选读）';
    det.appendChild(sum);
    var body = el('div', 'gb-tech-body');
    body.appendChild(el('p', null, '这份指南只讲怎么用。想知道每个功能背后的机制、可选组件和开发者向说明，看本页下方的「使用说明书」章节。'));
    body.appendChild(el('p', null, '如果你是在帮别人排查问题：让对方在「Diagnostics」里点「导出诊断报告」，把生成的文件发给你就够了，不需要让对方看任何命令窗口。'));
    det.appendChild(body);
    return det;
  }

  function render() {
    var host = byId(HOST_ID);
    if (!host) return false;
    injectStyles();
    host.innerHTML = '';

    var wrap = el('div', 'gb-wrap');

    var head = el('div', 'gb-head');
    head.appendChild(el('h2', 'gb-title', '零基础使用指南'));
    head.appendChild(el('p', 'gb-sub', '照着做就行：从第一次打开，到配置 AI、创建角色、开始聊天，以及出问题时怎么办。'));
    var meta = el('p', 'gb-meta');
    meta.appendChild(el('span', 'gb-meta-version', '适用于 InternalBeyond · 指南版本 ' + version()));
    meta.appendChild(el('span', 'gb-meta-note', '全程不需要打开任何命令窗口。'));
    head.appendChild(meta);
    wrap.appendChild(head);

    wrap.appendChild(buildIndex());

    var body = el('div', 'gb-body');
    for (var i = 0; i < CHAPTERS.length; i++) body.appendChild(renderChapter(CHAPTERS[i], i));
    wrap.appendChild(body);

    wrap.appendChild(buildTechNote());
    host.appendChild(wrap);
    return true;
  }

  /* ══ 对外接口（测试与后续阶段复用） ════════════════════════ */
  NS.VERSION_FALLBACK = VERSION_FALLBACK;
  NS.SHOT_DIR = SHOT_DIR;
  NS.HOST_ID = HOST_ID;
  NS.chapters = function () { return CHAPTERS; };
  NS.shots = function () {
    var out = [];
    for (var i = 0; i < CHAPTERS.length; i++) {
      var s = CHAPTERS[i].shots || [];
      for (var j = 0; j < s.length; j++) out.push(s[j].id);
    }
    return out;
  };
  NS.version = version;
  NS.render = render;

  function boot() {
    if (!render()) {
      /* 页面还没就绪时重试一次，避免脚本顺序造成的空挂载。 */
      setTimeout(render, 300);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
