/* IB Bridge · WebSocket 层：心跳、推送广播、连接类与消息分发。
   从 ib-bridge-service.js 提取为工厂：config / executeTool / TOOLS / 推送历史与锁
   均经依赖注入；wsSockets 集合随工厂返回共享引用，供诊断与状态接口读数。
   原逻辑逐字不变（含 close 帧先发后置 closed 的修复注释）。 */
'use strict';

function createWs(deps) {
  const config = deps.config;
  const executeTool = deps.executeTool;
  const tools = deps.tools;
  const maxFrame = deps.maxFrame;
  const serverName = deps.serverName;
  const version = deps.version;
  const pushHistory = deps.pushHistory;
  const withListLock = deps.withListLock;
  const uid = deps.uid;
  const savePushes = deps.savePushes;

  const wsSockets = new Set();
  let wsHeartbeatTimer = null;

  /* 服务端主动 ping：每 30 秒探测，60 秒无响应视为断线 */
  function wsHeartbeat() {
    const ping = Buffer.from(JSON.stringify({ type: 'ping' }), 'utf8');
    wsSockets.forEach(conn => {
      if (!conn.alive) { conn.close(1001, 'heartbeat timeout'); return; }
      conn.alive = false;
      try { conn.sendFrame(0x9, ping); } catch (e) { /* 忽略 */ }
    });
  }
  wsHeartbeatTimer = setInterval(wsHeartbeat, 30000);
  wsHeartbeatTimer.unref();

  function recordPush(p) {
    withListLock('pushes', () => {
      pushHistory.unshift({
        id: uid('push'), ts: Date.now(),
        title: p && p.title, text: p && p.text, from: p && p.from,
        bark: !!(p && p.bark), ntfy: !!(p && p.ntfy)
      });
      savePushes();
    });
  }

  function broadcast(obj) {
    const payload = Buffer.from(JSON.stringify(obj), 'utf8');
    wsSockets.forEach(conn => {
      try { conn.sendFrame(0x1, payload); } catch (e) { /* 忽略单个连接错误 */ }
    });
  }

  class WSConnection {
    constructor(socket, req) {
      this.socket = socket;
      this.req = req;
      this.buf = Buffer.alloc(0);
      this.fragments = [];
      this.fragOp = null;
      this.closed = false;
      this.alive = true;
      this.remote = req.socket && (req.socket.remoteAddress || '');
    }

    onData(chunk) {
      if (this.closed) return;
      this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
      this.alive = true;
      try { this.processFrames(); } catch (e) {
        this.close(1002, '协议解析错误');
      }
    }

    processFrames() {
      for (;;) {
        if (this.buf.length < 2) return;
        const b0 = this.buf[0], b1 = this.buf[1];
        const fin = (b0 & 0x80) !== 0;
        const opcode = b0 & 0x0f;
        const masked = (b1 & 0x80) !== 0;
        let len = b1 & 0x7f;
        let off = 2;
        if (len === 126) {
          if (this.buf.length < off + 2) return;
          len = this.buf.readUInt16BE(off);
          off += 2;
        } else if (len === 127) {
          if (this.buf.length < off + 8) return;
          const high = this.buf.readUInt32BE(off);
          const low = this.buf.readUInt32BE(off + 4);
          if (high !== 0 || low > maxFrame) throw new Error('frame too large');
          len = low;
          off += 8;
        }
        if (len > maxFrame) throw new Error('frame too large');
        let maskKey = null;
        if (masked) {
          if (this.buf.length < off + 4) return;
          maskKey = this.buf.slice(off, off + 4);
          off += 4;
        }
        if (this.buf.length < off + len) return;
        let payload = this.buf.slice(off, off + len);
        this.buf = this.buf.slice(off + len);
        if (maskKey) {
          const out = Buffer.allocUnsafe(payload.length);
          for (let i = 0; i < payload.length; i++) out[i] = payload[i] ^ maskKey[i & 3];
          payload = out;
        }
        if (opcode === 0x8) { /* close */
          let code = 1000, reason = '';
          if (payload.length >= 2) { code = payload.readUInt16BE(0); reason = payload.slice(2).toString('utf8'); }
          this.close(code === 1005 ? 1000 : code, reason);
          return;
        }
        if (opcode === 0x9) { /* ping */
          this.sendFrame(0xA, payload);
          continue;
        }
        if (opcode === 0xA) continue; /* pong */
        if (opcode === 0x0) { /* continuation */
          if (this.fragOp === null) throw new Error('unexpected continuation');
          this.fragments.push(payload);
          if (fin) {
            const full = Buffer.concat(this.fragments);
            const op = this.fragOp;
            this.fragments = [];
            this.fragOp = null;
            this.handleMessage(op, full);
          }
          continue;
        }
        if (opcode === 0x1 || opcode === 0x2) {
          if (!fin) {
            this.fragments = [payload];
            this.fragOp = opcode;
            continue;
          }
          this.handleMessage(opcode, payload);
          continue;
        }
        throw new Error('unsupported opcode ' + opcode);
      }
    }

    handleMessage(opcode, payload) {
      if (opcode !== 0x1) return;
      let msg = null;
      try { msg = JSON.parse(payload.toString('utf8')); } catch (e) { return; }
      if (!msg || typeof msg !== 'object') return;
      this.dispatch(msg);
    }

    dispatch(msg) {
      const t = msg.type;
      if (t === 'ping') {
        this.sendFrame(0x1, Buffer.from(JSON.stringify({ type: 'pong', t: msg.t })));
        return;
      }
      if (t === 'pong') return;
      if (t === 'hello') {
        const token = String(msg.token || '');
        const expect = String(config.token || '');
        if (expect && token !== expect) {
          this.close(4401, 'unauthorized');
          return;
        }
        this.authorized = true;
        wsSockets.add(this);
        this.sendFrame(0x1, Buffer.from(JSON.stringify({
          type: 'hello_ack', ok: true, server: serverName, version: version,
          tools: tools.map(x => ({ name: x.name, description: x.description, inputSchema: x.inputSchema }))
        })));
        return;
      }
      if (!this.authorized) {
        this.close(4401, 'unauthorized');
        return;
      }
      if (t === 'tool_catalog_request') {
        this.sendFrame(0x1, Buffer.from(JSON.stringify({ type: 'tool_catalog', tools: tools.map(x => ({ name: x.name, description: x.description, inputSchema: x.inputSchema })) })));
        return;
      }
      if (t === 'tool_call') {
        const id = String(msg.id || '');
        const name = String(msg.name || '');
        const args = msg.args && typeof msg.args === 'object' ? msg.args : {};
        Promise.resolve(executeTool(name, args)).then(r => {
          const out = { type: 'tool_result', id, ok: r.ok !== false, error: r.ok === false ? String(r.error || '工具调用失败') : '', text: String(r.text || ''), data: r.data };
          if (!this.closed) this.sendFrame(0x1, Buffer.from(JSON.stringify(out)));
        }).catch(e => {
          if (!this.closed) this.sendFrame(0x1, Buffer.from(JSON.stringify({ type: 'tool_result', id, ok: false, error: String(e && e.message || e).slice(0, 500), text: '' })));
        });
        return;
      }
      /* 其他类型原样忽略（未知消息不视为错误） */
    }

    sendFrame(opcode, payload) {
      if (this.closed) return;
      const len = payload.length;
      let header;
      if (len < 126) {
        header = Buffer.alloc(2);
        header[1] = len;
      } else if (len < 65536) {
        header = Buffer.alloc(4);
        header[1] = 126;
        header.writeUInt16BE(len, 2);
      } else {
        header = Buffer.alloc(10);
        header[1] = 127;
        header.writeUInt32BE(0, 2);
        header.writeUInt32BE(len, 6);
      }
      header[0] = 0x80 | (opcode & 0x0f);
      this.socket.write(Buffer.concat([header, payload]));
    }

    sendJson(obj) {
      this.sendFrame(0x1, Buffer.from(JSON.stringify(obj), 'utf8'));
    }

    close(code, reason) {
      if (this.closed) return;
      try {
        const rbuf = Buffer.from(String(reason || ''), 'utf8');
        const out = Buffer.alloc(2 + rbuf.length);
        out.writeUInt16BE(code || 1000, 0);
        rbuf.copy(out, 2);
        /* 必须先发 close frame 再置 closed，否则 sendFrame 会直接跳过 */
        this.sendFrame(0x8, out);
      } catch (e) { /* 忽略 */ }
      this.closed = true;
      wsSockets.delete(this);
      try { this.socket.end(); } catch (e) { /* 忽略 */ }
    }
  }

  return { wsSockets, wsHeartbeat, recordPush, broadcast, WSConnection };
}

module.exports = createWs;
