'use strict';
/* Internal Beyond — P6 截图管线专项测试
   运行：node test_guide_shots.js     （真实 Chrome/Edge + 真实静态服务 + 全新临时配置目录）

   覆盖：
     1. 管线能从零生成清单里的全部截图（真实页面、稳定 viewport、稳定文件名）
     2. 每张图都是 1440x900 的非空白 PNG，内容互不相同
     3. 标注（高亮框 + 说明）落在 viewport 内，且截图后标注层被清理
     4. 演示数据隔离：全新临时配置目录、结束后删除、不碰开发者真实数据
     5. 每张图对应的真实页面文本：内容正确、且不含任何真实凭据 / 私人数据
     6. 图片与正文解耦：把图片目录整体移走，Guide 正文仍完整（静态结构测试覆盖渲染，这里验证文件缺失可被容忍）

   产物写到系统临时目录，不覆盖仓库里已提交的 docs/guide/shots。 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/* Repository root — this file lives in tests/, so the root is one level up. */
const ROOT = path.resolve(__dirname, '..');

const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'guide', 'annotations.json'), 'utf8'));
const { capture, VIEWPORT } = require(path.join(ROOT, 'scripts', 'capture-guide-shots.js'));

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.error('  ✗ ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail) : '')); }
}
function section(t) { console.log('\n── ' + t + ' ──'); }

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-guide-shots-test-'));
const started = Date.now();

(async () => {
  let res = null;
  try {
    res = await capture({ outDir: outDir });
    const seconds = Math.round((Date.now() - started) / 1000);

    section('1. 生成结果');
    check('管线无问题项', res.problems.length === 0, res.problems);
    check('生成张数与清单一致', res.shots.length === MANIFEST.shots.length, { got: res.shots.length, want: MANIFEST.shots.length });
    check('每张都有产物记录', MANIFEST.shots.every(s => res.shots.some(r => r.id === s.id)),
      MANIFEST.shots.filter(s => !res.shots.some(r => r.id === s.id)).map(s => s.id));
    check('耗时在合理范围（< 300s）', seconds < 300, seconds + 's');
    check('页面没有未捕获异常', !res.appErrors || res.appErrors.length === 0, res.appErrors);
    console.log('    （用时 ' + seconds + 's）');

    section('2. 图片本身');
    const dims = new Set();
    const hashes = new Set();
    for (const r of res.shots) {
      const f = path.join(outDir, r.file);
      check('文件存在 ' + r.file, fs.existsSync(f));
      const buf = fs.existsSync(f) ? fs.readFileSync(f) : Buffer.alloc(0);
      const png = buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47;
      check('是 PNG ' + r.file, png);
      const w = png ? buf.readUInt32BE(16) : 0, h = png ? buf.readUInt32BE(20) : 0;
      check('尺寸为稳定 viewport ' + r.file, w === VIEWPORT.width && h === VIEWPORT.height, { w, h });
      check('不是空白图 ' + r.file, buf.length > 6000, buf.length);
      dims.add(w + 'x' + h);
      const sha = require('crypto').createHash('sha1').update(buf).digest('hex');
      check('内容唯一 ' + r.file, !hashes.has(sha));
      hashes.add(sha);
    }
    check('所有图尺寸一致', dims.size === 1, Array.from(dims));
    check('图片数量 >= 16', res.shots.length >= 16, res.shots.length);

    section('3. 标注');
    const annotated = res.shots.filter(r => r.annotated);
    check('需要标注的图都画了标注', annotated.length === MANIFEST.shots.filter(s => s.region !== 'none' && s.target).length,
      { annotated: annotated.length, want: MANIFEST.shots.filter(s => s.region !== 'none' && s.target).length });
    for (const r of annotated) {
      const b = r.box || {};
      check('标注框在 viewport 内 ' + r.id, b.x >= 0 && b.y >= 0 && b.w > 0 && b.h > 0 && b.x + b.w <= VIEWPORT.width + 1 && b.y + b.h <= VIEWPORT.height + 1, b);
    }
    check('每张标注图都有说明文字', annotated.every(r => {
      const s = MANIFEST.shots.filter(x => x.id === r.id)[0];
      return !!s && !!s.label;
    }));

    section('4. 演示数据隔离');
    check('使用了全新临时浏览器配置目录', !!res.profile && path.resolve(res.profile).indexOf(path.resolve(os.tmpdir())) === 0, res.profile);
    check('运行结束后删除临时配置目录', res.profileRemoved === true, res.profile);
    check('没有写到仓库里的 shots 目录（本次输出在临时目录）', path.resolve(outDir) !== path.resolve(ROOT, 'docs', 'guide', 'shots'));
    const fixture = require(path.join(ROOT, 'scripts', 'guide-fixtures.js'));
    check('演示数据自检通过', fixture.auditDemo().ok, fixture.auditDemo().problems);
    check('演示密钥是占位值', /^sk-demo-0+$/.test(fixture.DEMO.role.apiKey));

    section('5. 每张图对应的真实页面文本');
    const text = res.pageText || {};
    const must = {
      '01-welcome': ['开始设置', '查看说明', '跳过'],
      '02-provider': ['选择 AI 服务'],
      '03-api-key': ['API Key'],
      '04-test-ok': ['连接成功'],
      '05-role': ['角色'],
      '06-done': ['设置完成'],
      '07-chat': ['小助手', '示例用户', '今天有点累'],
      '08-api-entry': ['API'],
      '09-memory': ['用户喜欢在晚上聊天'],
      '10-active': ['允许角色主动联系'],
      '11-moments': ['社交圈'],
      '12-voice': ['Chat'],
      '13-diagnostics-ok': ['系统运行正常'],
      '14-diagnostics-degraded': ['不可用'],
      '15-repair': ['尝试修复'],
      '16-export': ['导出诊断报告']
    };
    for (const id of Object.keys(must)) {
      const t = String(text[id] || '');
      check('页面文本正确 ' + id, must[id].every(k => t.indexOf(k) !== -1), must[id].filter(k => t.indexOf(k) === -1));
    }
    check('degraded 图不再是「系统运行正常」', String(text['14-diagnostics-degraded'] || '').indexOf('系统运行正常') === -1);
    check('API Key 输入框不回显明文（密码框）', String(text['03-api-key'] || '').indexOf('sk-demo-') === -1);

    const RISK = [
      { re: /sk-(?!demo-0{4})[A-Za-z0-9_-]{10,}/, why: '疑似真实密钥' },
      { re: /sk-ant-|sk-proj-|sk-or-v1-/, why: '疑似真实厂商密钥' },
      { re: /Bearer\s+[A-Za-z0-9._-]{12,}/, why: '疑似 Bearer 令牌' },
      { re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, why: '疑似 JWT' },
      { re: /[\w.+-]+@(?!example\.com)[\w-]+\.[A-Za-z]{2,}/, why: '疑似真实邮箱' },
      { re: /1[3-9]\d{9}/, why: '疑似手机号' }
    ];
    for (const id of Object.keys(text)) {
      const t = String(text[id] || '');
      for (const r of RISK) check('不含' + r.why + '：' + id, !r.re.test(t));
    }

    section('6. 图片与正文解耦');
    /* 把产物整体移走，模拟「图片全部生成失败」：正文文件不受影响 */
    const moved = outDir + '-moved';
    fs.renameSync(outDir, moved);
    check('图片目录可整体移除', !fs.existsSync(outDir) && fs.existsSync(moved));
    const guideSrc = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'guide-beginner.js'), 'utf8');
    check('正文不依赖图片文件存在（无构建期读取）', !/readFileSync|require\(['"]fs['"]\)/.test(guideSrc));
    check('正文带加载失败回退', /addEventListener\('error'/.test(guideSrc) && /gb-shot-missing/.test(guideSrc));
    fs.renameSync(moved, outDir);

    console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  } catch (e) {
    fail++;
    console.error('  ✗ 管线异常：' + String(e && e.stack || e));
    console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  } finally {
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (e) { }
    try { fs.rmSync(outDir + '-moved', { recursive: true, force: true }); } catch (e) { }
  }
  process.exitCode = fail ? 1 : 0;
})();
