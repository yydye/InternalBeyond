/* ====================================================================
   IB Bridge · Alipay Payment Provider（支付宝 AI 付）
   --------------------------------------------------------------------
   实现 Provider 接口（name='alipay'），通过 alipay-bot CLI 提交支付，
   复用在 Node.js 环境 spawn『白名单命令』(参考思路，但封装为本地
   Provider，绝不新增独立 8933 bridge)。

   安全（比参考更严，都在 23115 进程内）：
     · 收银台 URL 必须是 https://<子域>.cashier*.alipay.com/（严格前缀匹配）
     · 命令固定为 alipay-bot submit-payment --payment-link <url>（无 shell 拼接）
     · 超时 → TIMEOUT；非零退出 → FAIL；不可执行 → FAIL
   依赖注入：exec(cmd, args, opts) 默认用 child_process.spawnSync，
   测试时可注入 mock（不触碰真实 alipay-bot）。
   ==================================================================== */
'use strict';

const { spawnSync } = require('child_process');

/* cashier*.alipay.com 严格匹配：host 以 cashier 开头、以 .alipay.com 结尾、全局仅此域名 */
const CASHIER_RE = /^https:\/\/(?:[a-z0-9-]+\.)?cashier[\w.-]*\.alipay\.com\//i;

function createAlipayProvider(deps) {
  deps = deps || {};
  const _exec = deps.exec || defaultExec;
  const _timeoutMs = deps.timeoutMs || 30000;

  function defaultExec(args, opts) {
    const r = spawnSync(args[0], args.slice(1), { encoding: 'utf8', timeout: opts && opts.timeoutMs });
    if (r.error && /ETIMEDOUT|SPAWN_ETIMEDOUT/i.test(String(r.error.message || ''))) {
      return { ok: false, timeout: true, stdout: '', stderr: String(r.error.message || '') };
    }
    return { ok: r.status === 0, code: r.status, stdout: String(r.stdout || ''), stderr: String(r.stderr || '') };
  }

  async function submit(intent, opts) {
    const url = String((intent && intent.checkoutUrl) || '');
    /* Provider 级防御：即使 gate 漏检，此处也二次收紧 https + cashier*.alipay.com */
    if (!CASHIER_RE.test(url)) {
      return { status: 'FAIL', reference: '', error: '非 cashier*.alipay.com 的 HTTPS 收银台，拒绝提交' };
    }
    const args = ['alipay-bot', 'submit-payment', '--payment-link', url];
    let r;
    try {
      r = _exec(args, { timeoutMs: _timeoutMs });
    } catch (e) {
      return { status: 'FAIL', reference: '', error: String((e && e.message) || 'alipay-bot 执行异常') };
    }
    if (!r) return { status: 'FAIL', reference: '', error: 'alipay-bot 无返回' };
    if (r.timeout) return { status: 'TIMEOUT', reference: '', error: 'alipay-bot 超时（' + _timeoutMs + 'ms）' };
    if (!r.ok) return { status: 'FAIL', reference: '', error: String(r.stderr || 'alipay-bot 失败').slice(0, 300) };
    /* 成功：尝试提取交易引用（JSON 或文本中的 ref/shortUrl/orderId） */
    const out = String(r.stdout || '');
    const ref = extractReference(out);
    return { status: 'SUCCESS', reference: ref, error: '' };
  }

  function extractReference(out) {
    try {
      const j = JSON.parse(out);
      return j.reference || j.orderId || j.order_id || j.shortUrl || j.tradeNo || '';
    } catch (e) { /* 非 JSON 走文本 */ }
    const m = String(out || '').match(/orderId["':=\s]+([\w-]+)/i) ||
              String(out || '').match(/(?:reference|tradeNo|shortUrl)["':=\s]+([\w-]+)/i);
    return m ? m[1] : '';
  }

  return { name: 'alipay', submit: submit, CASHIER_RE: CASHIER_RE };
}

module.exports = createAlipayProvider;
