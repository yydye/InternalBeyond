'use strict';
/* ====================================================================
   Internal Beyond · M1-C.2b.2 Runtime Spec Write Boundary Closure
   运行：node tests/test_mobile_publish_spec_boundary.js

   背景（OQ-1 已实证的 write-boundary defect）：
     mobile-gateway.js 的 /characters/publish 曾用

         projected.spec || entry.spec || null

     作为 runtime spec 的写入值。`projected.spec` 来自 canonical 白名单投影
     mapSpec()，但 `entry.spec` 是**调用方自带的任意对象** —— 于是
     imageGenApiKey 这类白名单外的凭据可以原样落进
     character_runtime_specs（实测键序 provider,model,endpoint,apiKey,
     systemPrompt,imageGenApiKey）。

   本测试锁定修复后的边界语义：runtime spec 的唯一入口是 mapSpec 的输出。
   它刻意走**真实 HTTP publish 边界**，再直接从 registry 读回落盘结果 ——
   因为缺陷本就在"HTTP 入口 → 落盘"这一段，只在 DTO 层断言会漏掉它。

   四组：
     P1-A canonical path 正常落库，且合法字段集合不变
     P1-B raw spec bypass 被关闭（imageGenApiKey 无法落盘）
     P1-C secret boundary 不退化（只出现在 runtime spec 与执行路径）
     P1-D structural guard（防止未来重新引入 raw spec 回落）
   ==================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const SERVICE = require(path.join(ROOT, 'services', 'home-node-service.js'));
const REGISTRY_SRC = fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'device-registry.js'), 'utf8');
const GATEWAY_SRC = fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'mobile-gateway.js'), 'utf8');

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('OK   ' + name); }
  else { failed++; console.error('FAIL ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}

function request(port, method, urlPath, options) {
  options = options || {};
  return new Promise(resolve => {
    const data = options.body == null ? null
      : (typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    const headers = Object.assign({}, options.headers || {});
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    const req = http.request({ host: '127.0.0.1', port: port, path: urlPath, method: method, timeout: 8000, headers: headers }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', c => raw += c);
      res.on('end', () => {
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : {}; } catch (_) { parsed = { raw: raw }; }
        resolve({ status: res.statusCode, body: parsed, headers: res.headers, raw: raw, text: raw });
      });
      res.on('error', e => resolve({ status: 0, body: null, error: e.message }));
    });
    req.on('timeout', () => { try { req.destroy(); } catch (_) {} resolve({ status: 0, body: null, error: 'timeout' }); });
    req.on('error', e => resolve({ status: 0, body: null, error: e.message }));
    if (data) req.write(data);
    req.end();
  });
}

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

/* 标记值刻意是唯一字符串：任何出站面出现它都说明边界漏了。 */
const M = {
  apiKey: 'sk-CANONICAL-APIKEY-MARKER',
  imageGen: 'sk-IMAGEGEN-MUST-NOT-PERSIST',
  systemPrompt: 'SYSTEM-PROMPT-MARKER',
  endpoint: 'https://canonical-provider.example/v1/chat/completions',
  voiceKey: 'sk-VOICE-MUST-NOT-PERSIST'
};

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-spec-boundary-'));
  const ADMIN_TOKEN = 'boundary-admin-token';
  const instance = SERVICE.buildHomeNode({ dataDir: dataDir, token: ADMIN_TOKEN, logger: () => {} });
  instance.open();
  const registry = instance.registry;
  const port = await listen(instance.server);
  const admin = { 'X-IB-Home-Token': ADMIN_TOKEN };

  try {
    /* ══ P1-A · canonical path（真实 apiConfigs 形状）════════════════
       desktopCharacters() 发的是**原始 apiConfigs 条目**（未投影），
       所以这里就用那个形状走完整链路。 */
    const canonical = {
      id: 'char_canonical', nickname: '小满', relationship: '同桌',
      provider: 'custom', model: 'canonical-model', endpoint: M.endpoint,
      apiKey: M.apiKey, systemPrompt: M.systemPrompt,
      temperature: 0.7, thinkingEnabled: true, showThinking: false,
      /* 白名单外的字段：必须被 mapSpec 投影掉 */
      imageGenApiKey: M.imageGen, voiceApiKey: M.voiceKey, vision: true
    };
    const pubA = await request(port, 'POST', '/characters/publish', {
      headers: admin, body: { characters: [canonical], merge: true }
    });
    check('P1-A publish 成功且报告 withSpec=1',
      pubA.status === 200 && pubA.body.payload.count === 1 && pubA.body.payload.withSpec === 1, pubA.body.payload);

    const specA = registry.getCharacterSpec('char_canonical');
    check('P1-A runtime spec 正常落库', !!specA, specA);
    check('P1-A 合法字段按 P34.3-B 语义保留（provider/model/endpoint/credentialRef/systemPrompt，无 apiKey）',
      specA && specA.provider === 'custom' && specA.model === 'canonical-model' &&
      specA.endpoint === M.endpoint && specA.credentialRef === 'char_canonical' && specA.apiKey === undefined &&
      specA.systemPrompt === M.systemPrompt, specA && Object.keys(specA));
    check('P1-A 条件字段按 mapSpec 现有语义保留（temperature/thinkingEnabled/showThinking）',
      specA && specA.temperature === 0.7 && specA.thinkingEnabled === true && specA.showThinking === false,
      specA && Object.keys(specA));
    check('P1-A 白名单外字段被投影掉（imageGenApiKey / voiceApiKey / vision）',
      specA && specA.imageGenApiKey === undefined && specA.voiceApiKey === undefined && specA.vision === undefined,
      specA && Object.keys(specA));
    check('P1-A 角色可执行（forTurn=true）', registry.getCharacter('char_canonical').forTurn === true);

    /* 幂等：重复发布会覆盖而不是产生第二行 —— 用**已投影**形状再发一次。
       （生产里 desktopCharacters() 永远发原始形状，但 gateway 的注释明确
        允许"已投影的 {id,dto,spec}"，两条形状都必须仍然工作。） */
    const reproject = await request(port, 'POST', '/characters/publish', {
      headers: admin,
      body: {
        merge: true,
        characters: [{
          id: 'char_canonical',
          dto: { id: 'char_canonical', name: '小满', relationship: '同桌' },
          spec: { provider: 'custom', model: 'reprojected-model', endpoint: M.endpoint, apiKey: M.apiKey }
        }]
      }
    });
    check('P1-A 已投影形状（{id,dto,spec}）仍可用且幂等',
      reproject.status === 200 && reproject.body.payload.withSpec === 1 &&
      registry.getCharacterSpec('char_canonical').model === 'reprojected-model' &&
      registry.listCharacters().length === 1, reproject.body.payload);
    check('P1-A 已投影形状的 spec 同样过白名单（二次投影只含 credentialRef，不引入 apiKey）',
      Object.keys(registry.getCharacterSpec('char_canonical')).sort().join(',') === 'credentialRef,endpoint,model,provider');

    /* ══ P1-B · raw spec bypass（OQ-1 的实测攻击形状）════════════════
       触发条件必须精确，否则这条测试是假绿：
         · 若条目带**顶层** provider/model/endpoint/apiKey，characterCatalogEntry
           走分支①，mapSpec(raw) 返回非 null —— 回落根本不执行；
         · 若条目带非空 dto，走分支②，mapSpec(raw.spec) 会**投影** entry.spec，
           imageGenApiKey 同样被白名单挡掉；
         · 只有"顶层凭据字段全缺席 **且** entry.spec 自带完整 5 键子集"时，
           mapSpec(raw) 返回 null，`projected.spec || entry.spec` 才回落到
           entry.spec —— 而 putCharacter 对 runtimeSpec **只做 JSON.stringify**，
           于是白名单外的键完整落盘。
       这正是 OQ-1 E3 实测的键序 provider,model,endpoint,apiKey,systemPrompt,imageGenApiKey。 */
    const bypass = await request(port, 'POST', '/characters/publish', {
      headers: admin,
      body: {
        merge: true,
        characters: [{
          id: 'char_bypass', nickname: 'Bypass',
          /* 顶层**没有** provider/model/endpoint/apiKey ⇒ mapSpec(entry) === null */
          spec: {
            provider: 'custom', model: 'bypass-model', endpoint: 'https://attacker.example/v1',
            apiKey: 'sk-ATTACKER', systemPrompt: 'INJECTED-PROMPT',
            imageGenApiKey: M.imageGen
          }
        }]
      }
    });
    check('P1-B publish 请求本身仍被接受（不是靠拒绝请求来"修"）', bypass.status === 200, bypass.body);

    const specB = registry.getCharacterSpec('char_bypass');
    check('P1-B 回落分支关闭：entry.spec 不再作为 runtime spec 落库', specB === null, specB);
    check('P1-B imageGenApiKey 无法进入 character_runtime_specs',
      JSON.stringify(specB) === 'null' || JSON.stringify(specB).indexOf(M.imageGen) < 0, specB);
    check('P1-B 角色因此不可执行（forTurn=false，而不是带一个伪造 spec 运行）',
      registry.getCharacter('char_bypass').forTurn === false, registry.getCharacter('char_bypass'));

    /* 反证：即便 entry.spec 只含白名单内的键，也不该被当作 canonical spec。
       否则"绕过"会以一个更隐蔽的形式回来（伪造 endpoint 换掉真实 provider），
       而且那种形式不会有 imageGenApiKey 这种显眼标记。 */
    await request(port, 'POST', '/characters/publish', {
      headers: admin,
      body: {
        merge: true,
        characters: [{
          id: 'char_bypass2', nickname: 'Bypass2',
          spec: { provider: 'custom', model: 'm', endpoint: 'https://attacker.example/v1', apiKey: 'sk-ATTACKER' }
        }]
      }
    });
    check('P1-B 纯白名单键的 entry.spec 同样不被当作 canonical spec（不能换端点）',
      registry.getCharacterSpec('char_bypass2') === null, registry.getCharacterSpec('char_bypass2'));

    /* putCharacter 本身仍然接受合法 spec —— 边界收在 gateway，不在 registry。 */
    check('P1-B 收口不误伤 registry 层（putCharacter 的合法调用仍然成功）',
      registry.putCharacter('char_direct', { id: 'char_direct', name: 'D' },
        { provider: 'custom', model: 'm', endpoint: 'https://ok.example/v1', apiKey: 'sk-OK' }, {}).ok === true &&
      registry.getCharacterSpec('char_direct').apiKey === 'sk-OK');

    /* ══ P1-C · secret boundary 不退化 ═══════════════════════════════
       runtime spec 可以存在于 Node，但绝不能出现在任何出站面。
       mobile 面全部需要设备凭据 —— 先真实配对一台设备，否则这些请求会
       以 AUTH_REQUIRED 返回，测试就变成"断言一个错误响应不含 secret"（假绿）。 */
    const sPair = await request(port, 'POST', '/pairing/session', {
      headers: admin, body: { deviceName: 'Boundary', deviceType: 'android' }
    });
    const cPair = await request(port, 'POST', '/mobile/v1/pairing/complete', {
      body: {
        v: 1, payload: {
          pairingId: sPair.body.payload.pairingId, secret: sPair.body.payload.secret,
          deviceName: 'Boundary', deviceType: 'android'
        }
      }
    });
    const auth = { Authorization: 'Bearer ' + cPair.body.payload.token };
    check('P1-C 设备配对成功（后续输出面断言基于真实认证响应）',
      cPair.status === 200 && typeof cPair.body.payload.token === 'string', cPair.body);

    const leak = new RegExp([M.apiKey, M.imageGen, M.voiceKey, M.systemPrompt,
      'apiKey', 'authorization', 'bearer'].join('|'), 'i');
    const mobileSurfaces = [
      ['GET', '/mobile/v1/handshake'],
      ['GET', '/mobile/v1/device/self'],
      ['GET', '/mobile/v1/character/list'],
      ['GET', '/mobile/v1/character/char_canonical'],
      ['GET', '/mobile/v1/chat/history?characterId=char_canonical'],
      ['GET', '/mobile/v1/sync/changes?cursor=0']
    ];
    const mobileReplies = [];
    for (const [method, urlPath] of mobileSurfaces) {
      const r = await request(port, method, urlPath, { headers: auth });
      mobileReplies.push({ path: urlPath, status: r.status, text: r.text });
    }
    check('P1-C mobile 输出面真的返回了 200（不是被鉴权拦掉的空断言）',
      mobileReplies.every(r => r.status === 200), mobileReplies.map(r => [r.path, r.status]));
    check('P1-C character.list / DTO / history / sync / handshake 均不含 runtime spec 与任何凭据',
      mobileReplies.every(r => !leak.test(r.text)),
      mobileReplies.filter(r => leak.test(r.text)).map(r => ({ path: r.path, sample: r.text.slice(0, 240) })));

    const adminReplies = [];
    for (const urlPath of ['/characters', '/devices']) {
      const r = await request(port, 'GET', urlPath, { headers: admin });
      adminReplies.push({ path: urlPath, status: r.status, text: r.text });
    }
    check('P1-C 管理面 /characters /devices 同样不含 spec 与凭据',
      adminReplies.every(r => r.status === 200 && !leak.test(r.text)),
      adminReplies.map(r => ({ path: r.path, status: r.status, sample: r.text.slice(0, 200) })));

    const pubLeak = leak.test(pubA.text) || leak.test(bypass.text);
    check('P1-C publish 响应不回显 spec（只报 count/withSpec）', pubLeak === false,
      { a: pubA.text.slice(0, 160), b: bypass.text.slice(0, 160) });

    /* relationship / nickname 本来就是 public DTO 字段 —— 不能因为防泄漏把它误杀。
       这条同时证明上面的 leak 正则没有把整个 DTO 路径一起误判成泄漏。 */
    const listText = mobileReplies.find(r => r.path === '/mobile/v1/character/list').text;
    check('P1-C public DTO 仍保留展示身份（nickname / relationship 不被误判为 secret）',
      listText.indexOf('小满') >= 0 && listText.indexOf('同桌') >= 0, listText.slice(0, 300));

    /* ══ P1-D · structural guard ═════════════════════════════════════
       轻量结构守卫：防止未来重新引入 raw spec 回落。
       刻意不做整文件 snapshot（那样的测试会因为无关改动而红）。 */
    const specExprs = GATEWAY_SRC.match(/spec:\s*projected\.spec[^\n]*/g) || [];
    check('P1-D gateway 中 runtime spec 只从 projected.spec 取值（无 || / ?? 回落）',
      specExprs.length > 0 && specExprs.every(s => !/\|\|\s*entry\.spec/.test(s) && !/\?\?\s*entry\.spec/.test(s)),
      specExprs);
    /* 语义等价形式：publish 循环里任何对 entry.spec 的读取都是嫌疑点。
       （characterCatalogEntry 自己读 raw.spec 是对的 —— 那才是应该投影的地方，
        所以这里只查 gateway，且只查 entry.spec 这个名字。） */
    const rawSpecReads = (GATEWAY_SRC.match(/\bentry\.spec\b/g) || []).length;
    check('P1-D gateway 不再读取 entry.spec（raw spec 无法作为第二入口）',
      rawSpecReads === 0, rawSpecReads);
    /* 用真实行为反向确认同一件事：绕过形状落盘为空（P1-B 已断言）+ 源码无回落。
       两条一起才排得掉"测试形状恰好不触发"的假绿。 */
    check('P1-D 白名单投影仍是唯一 projector（mapSpec 未被旁路替代）',
      /function mapSpec\(raw\)/.test(fs.readFileSync(path.join(ROOT, 'assets', 'js', 'mobile-dto.js'), 'utf8')));

    /* registry 侧不新增第二条 spec 写入路径：只有 putCharacter 一处 upsert。 */
    const specUpserts = (REGISTRY_SRC.match(/SQL\.upsertCharacterSpec/g) || []).length;
    check('P1-D registry 中 spec 写入点唯一（upsertCharacterSpec 只被调用一次）',
      specUpserts === 1, specUpserts);
  } catch (error) {
    failed++;
    console.error('FAIL spec boundary 测试异常终止 — ' + String((error && error.stack) || error));
  } finally {
    instance.close();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {}
  }

  if (failed) { console.error('M1-C.2b.2 runtime spec write boundary 测试失败：' + failed + ' 项（通过 ' + passed + '）'); process.exitCode = 1; }
  else console.log('M1-C.2b.2 runtime spec write boundary tests passed (' + passed + ' 项)');
})();
