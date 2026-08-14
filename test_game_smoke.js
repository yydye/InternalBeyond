'use strict';

/* SUI'S ROOM — 游戏模块冒烟测试（Node 18+，零依赖，需本机 Chrome / Edge）。
   验证 game/ 目录按域拆分的六个模块全部加载，且核心交互链路可用：
   面板初始化、塔罗、换装、茶歇选单、故事视窗、对话分页、Sui 问答、
   行走、存档、主题联动与宠物小窗。全程收集未捕获异常。 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const PAGE_URL = pathToFileURL(path.join(__dirname, 'InternalBeyond.html')).href;

function chromePath() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  for (const candidate of [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ]) if (fs.existsSync(candidate)) return candidate;
  return null;
}

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    socket.on('data', chunk => { this.buffer = Buffer.concat([this.buffer, chunk]); this.parse(); });
    socket.on('error', () => {});
  }
  static connect(wsUrl) {
    return new Promise((resolve, reject) => {
      const url = new URL(wsUrl);
      const request = http.request({
        host: url.hostname, port: url.port, path: url.pathname + url.search,
        headers: {
          Upgrade: 'websocket', Connection: 'Upgrade',
          'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'), 'Sec-WebSocket-Version': '13'
        }
      });
      request.on('upgrade', (response, socket) => resolve(new Cdp(socket)));
      request.on('error', reject);
      request.end();
    });
  }
  on(method, listener) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(listener);
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.sendText({ id, method, params });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); } }, 15000);
    });
  }
  sendText(message) {
    const payload = Buffer.from(JSON.stringify(message), 'utf8');
    const mask = crypto.randomBytes(4);
    const body = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) body[i] = payload[i] ^ mask[i & 3];
    let header;
    if (payload.length < 126) header = Buffer.from([0x81, 0x80 | payload.length]);
    else { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2); }
    this.socket.write(Buffer.concat([header, mask, body]));
  }
  sendFrame(opcode, payload) {
    const mask = crypto.randomBytes(4);
    const body = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) body[i] = payload[i] ^ mask[i & 3];
    let header;
    if (payload.length < 126) header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
    else { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2); }
    this.socket.write(Buffer.concat([header, mask, body]));
  }
  parse() {
    for (;;) {
      if (this.buffer.length < 2) return;
      const first = this.buffer[0];
      const shortLength = this.buffer[1] & 0x7f;
      let offset = 2;
      let length = shortLength;
      if (shortLength === 126) { if (this.buffer.length < 4) return; length = this.buffer.readUInt16BE(2); offset = 4; }
      else if (shortLength === 127) { if (this.buffer.length < 10) return; length = this.buffer.readUInt32BE(6); offset = 10; }
      const masked = (this.buffer[1] & 0x80) !== 0;
      let mask = null;
      if (masked) { if (this.buffer.length < offset + 4) return; mask = this.buffer.subarray(offset, offset + 4); offset += 4; }
      if (this.buffer.length < offset + length) return;
      let payload = this.buffer.subarray(offset, offset + length);
      this.buffer = this.buffer.subarray(offset + length);
      if (mask) {
        const decoded = Buffer.alloc(payload.length);
        for (let i = 0; i < payload.length; i++) decoded[i] = payload[i] ^ mask[i & 3];
        payload = decoded;
      }
      const opcode = first & 0x0f;
      if (opcode === 0x8) return this.close();
      if (opcode === 0x9) { this.sendFrame(0xA, payload); continue; }
      if (opcode !== 0x1) continue;
      let message;
      try { message = JSON.parse(payload.toString('utf8')); } catch (error) { continue; }
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
        else pending.resolve(message.result || {});
      } else if (message.method && this.listeners.has(message.method)) {
        for (const listener of this.listeners.get(message.method)) listener(message.params || {});
      }
    }
  }
  close() { try { this.socket.destroy(); } catch (error) { /* ignore */ } }
}

async function evaluate(cdp, expression) {
  const response = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) throw new Error('page exception: ' + JSON.stringify(response.exceptionDetails.exception));
  return response.result && response.result.value;
}

async function waitFor(cdp, expression, timeoutMs = 10000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { if (await evaluate(cdp, expression)) return true; } catch (error) { /* still loading */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return false;
}

/* 对话推进：打字机打完当前页后不会自动翻页，需要点击 next 按钮触发 advanceDialogue。
   循环点击直到目标状态出现（第一击收尾打字，第二击翻页，末页触发回调）。
   仅在对话真正打开时才点击：走路 / 等待期间的空 advanceDialogue 会 closeDialogue 并打断流程。 */
async function ffUntil(cdp, untilExpr, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await evaluate(cdp, untilExpr)) return true;
    await evaluate(cdp, "try{ if(window.G.dialogueActive){ var b=document.getElementById('game-dlg-next-btn'); if(b && b.style.display!=='none') b.click(); } }catch(e){}");
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  return false;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function main() {
  const chrome = chromePath();
  if (!chrome) throw new Error('未找到 Chrome / Edge；可通过 CHROME_PATH 指定浏览器');
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-game-smoke-'));
  const browser = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--allow-file-access-from-files', '--force-color-profile=srgb',
    '--window-size=1440,900', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port,
    '--user-data-dir=' + profile, 'about:blank'
  ], { stdio: 'ignore' });

  let failures = 0;
  const check = (name, condition, detail = '') => {
    if (condition) console.log('  PASS  ' + name);
    else { failures++; console.error('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
  };
  let cdp;

  try {
    let ready = false;
    for (let i = 0; i < 120; i++) {
      try {
        const response = await fetch('http://127.0.0.1:' + port + '/json/version');
        if (response.ok) { ready = true; break; }
      } catch (error) { /* browser is starting */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    check('browser.ready', ready);
    if (!ready) throw new Error('Chrome DevTools 未就绪');

    const tabResponse = await fetch('http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent(PAGE_URL), { method: 'PUT' });
    const tab = await tabResponse.json();
    cdp = await Cdp.connect(tab.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    const exceptions = [];
    cdp.on('Runtime.exceptionThrown', params => {
      const d = params.exceptionDetails || {};
      const text = JSON.stringify(d.exception && d.exception.description || d.text || '');
      exceptions.push(text);
    });

    check('page.gLoaded', await waitFor(cdp, "typeof window.G === 'object' && window.G !== null", 15000));
    check('page.gameCssInjected', await waitFor(cdp, "!!document.getElementById('game-css') && document.getElementById('game-css').textContent.length > 5000", 15000));
    check('page.gameHtmlInjected', await waitFor(cdp, "!!document.getElementById('game-panel') && !!document.getElementById('page-game') && !!document.getElementById('game-mini') && !!document.getElementById('game-pet-window')", 15000));

    /* 0. IB 全局命名空间骨架与已迁移文件 */
    check('ns.boot', await evaluate(cdp, "typeof window.IB === 'object' && window.IB.__boot && window.IB.__boot.version === 1 && typeof window.IB.section === 'function'"));
    check('ns.email', await evaluate(cdp, "typeof window.IB.email === 'object' && typeof window.IB.email.revealIBEmails === 'function'"));
    check('ns.room', await evaluate(cdp, "typeof window.IB.room === 'object' && typeof window.IB.room.moveRoomTab === 'function'"));
    check('ns.preloader', await evaluate(cdp, "window.IB.preloader && window.IB.preloader.mounted === true"));
    check('ns.localfirst', await evaluate(cdp, "window.IB.localfirst && typeof window.IB.localfirst.setQuietMode === 'function' && typeof window.IB.localfirst.isLocalUrl === 'function'"));
    check('ns.vault', await evaluate(cdp, "window.IB.vault && window.IB.vault.mounted === true && window.IB.vault.format === 'InternalBeyondEncryptedBackup'"));
    check('ns.ops', await evaluate(cdp, "window.IB.ops && typeof window.IB.ops.buildSiteContext === 'function' && typeof window.IB.ops._getIbToolResultInjection === 'function' && typeof window.IB.ops._WS_INSTR_BLOCK === 'string'"));
    check('ns.ops.dualAttach', await evaluate(cdp, "typeof window._getIbToolResultInjection === 'function' && typeof window.ibToolTest === 'function' && typeof window.clearAllApiKeys === 'function' && typeof window._WS_INSTR_BLOCK === 'string'"));
    check('ns.chat', await evaluate(cdp, "window.IB.chat && typeof window.IB.chat.callApiChatStream === 'function' && typeof window.IB.chat.openChatPanel === 'function' && typeof window.IB.chat.sendChatMessage === 'function'"));
    check('ns.chat.dualAttach', await evaluate(cdp, "typeof window.callApiChatStream === 'function' && typeof window.openChatPanel === 'function' && typeof window.stopStreaming === 'function'"));
    check('ns.workspace', await evaluate(cdp, "window.IB.workspace && typeof window.IB.workspace.openWorkspace === 'function' && typeof window.IB.workspace._parseWsOps === 'function'"));
    check('ns.workspace.dualAttach', await evaluate(cdp, "typeof window.openWorkspace === 'function' && typeof window.closeWorkspace === 'function'"));
    check('ns.memory', await evaluate(cdp, "window.IB.memory && typeof window.IB.memory.getMemoryScore === 'function' && typeof window.IB.memory.openMemoryModal === 'function'"));
    check('ns.memory.dualAttach', await evaluate(cdp, "typeof window.getMemoryScore === 'function' && typeof window.renderMemories === 'function'"));
    check('ns.core', await evaluate(cdp, "window.IB.core && typeof window.IB.core.navTo === 'function' && typeof window.IB.core.toast === 'function' && typeof window.IB.core.ensureDB === 'function'"));
    check('ns.core.dualAttach', await evaluate(cdp, "typeof window.navTo === 'function' && typeof window.toast === 'function' && typeof window.openDB === 'function' && typeof window.DB_NAME === 'string'"));
    check('ns.glass', await evaluate(cdp, "window.IB.glassCanvas && window.IB.glassCanvas.mounted === true && window.IB.glassRipple && window.IB.glassRipple.mounted === true"));
    check('ns.memorySky', await evaluate(cdp, "window.IB.memorySky && window.IB.memorySky.mounted === true && typeof window.IB.memorySky.build === 'function'"));
    check('ns.bridge', await evaluate(cdp, "window.IB.bridge && window.IB.bridge.mounted === true"));
    check('ns.social', await evaluate(cdp, "window.IB.social && typeof window.IB.social.addNewApi === 'function' && typeof window.addNewApi === 'function' && Array.isArray(window.apiConfigs)"));
    check('ns.ext', await evaluate(cdp, "window.IB.ext && typeof window.IB.ext.ibExtSay === 'function' && typeof window.IBNET === 'object'"));
    check('ns.calendar', await evaluate(cdp, "window.IB.calendar && window.IB.calendar.mounted === true"));
    check('ns.active', await evaluate(cdp, "window.IB.active && typeof window.IB.active.initActiveMessages === 'function' && typeof window.initActiveMessages === 'function'"));
    check('ns.game', await evaluate(cdp, "window.IB.game && typeof window.IB.game.openTarot === 'function' && typeof window.IB.game.showDialogue === 'function' && typeof window.IB.game.gameLoop === 'function'"));
    check('ns.game.dualAttach', await evaluate(cdp, "typeof window.openTarot === 'function' && typeof window.showDialogue === 'function' && typeof window.startHomeTour === 'function' && typeof window.G === 'object'"));

    /* 1. All six split modules evaluated (each exposes its top-level functions) */
    check('split.coreModule', await evaluate(cdp, "typeof injectCSS === 'function' && typeof createViewport === 'function' && typeof interactBed === 'function'"));
    check('split.tarotModule', await evaluate(cdp, "typeof openTarot === 'function' && typeof generateTarotFan === 'function' && typeof TAROT_DECK !== 'undefined' && TAROT_DECK.length === 78"));
    check('split.storyModule', await evaluate(cdp, "typeof startAiGame === 'function' && typeof openStoryWindow === 'function' && typeof STORY_CSS === 'string'"));
    check('split.dialogueModule', await evaluate(cdp, "typeof paginateDialogue === 'function' && typeof showSuiPage === 'function' && typeof window.startHomeTour === 'function'"));
    check('split.roomModule', await evaluate(cdp, "typeof openWardrobe === 'function' && typeof gameLoop === 'function' && typeof bootstrap === 'function'"));
    check('split.teaModule', await evaluate(cdp, "typeof openTeaSelect === 'function' && typeof teaChatSend === 'function' && typeof TEA_DRINKS !== 'undefined' && TEA_DRINKS.length === 5"));
    check('state.windowG', await evaluate(cdp, "window.G && window.G.outfitIdx === 2 && typeof window.G.viewport === 'object'"));

    /* 2. Open the floating panel and initialize the engine */
    await evaluate(cdp, "openGamePanel()");
    check('engine.initialized', await waitFor(cdp, "window.G.initialized === true && window.G.running === true", 20000));
    check('engine.viewport', await evaluate(cdp, "!!(window.G.viewport && window.G.viewport.querySelector('#game-char') && window.G.viewport.querySelector('#game-indicators'))"));
    check('engine.scale', await evaluate(cdp, "window.G.scale > 0 && window.G.scale <= 1"));

    /* 角色开局处于 sleeping，随后自动醒来（sleeping → waking → idle）。
       onInteract 在 sleeping/waking 状态下会吞掉交互点击（房间设计如此），先等角色醒来。 */
    check('engine.awake', await waitFor(cdp, "window.G.state === 'idle'", 15000));

    /* 3. Tarot (via sidebar click like the user; dialogue intro is typewritten, fast-forward it) */
    await evaluate(cdp, "document.querySelector('#game-sidebar [data-action=\"crystal\"]').click()");
    check('tarot.open', await ffUntil(cdp, "window.G.tarotOpen === true && window.G.viewport.querySelector('#game-tarot') && window.G.viewport.querySelector('#game-tarot').classList.contains('show')"));
    check('tarot.deckUI', await evaluate(cdp, "!!window.G._tarot && window.G._tarot.deck.length === 78 && !!window.G.viewport.querySelector('#tarot-fan')"));
    await evaluate(cdp, "closeTarot()");
    check('tarot.close', await evaluate(cdp, "window.G.tarotOpen === false"));

    /* 4. Wardrobe */
    await evaluate(cdp, "openWardrobe()");
    check('wardrobe.open', await waitFor(cdp, "!!window.G.viewport.querySelector('#game-wardrobe') && window.G.viewport.querySelector('#game-wardrobe').classList.contains('show')", 5000));
    await evaluate(cdp, "closeWardrobe()");
    check('wardrobe.close', await evaluate(cdp, "window.G.wardrobeOpen === false"));

    /* 5. Tea selection overlay */
    await evaluate(cdp, "openTeaSelect()");
    check('tea.open', await waitFor(cdp, "!!window.G.viewport.querySelector('#game-tea-overlay') && window.G.viewport.querySelector('#game-tea-overlay').classList.contains('show')", 5000));
    check('tea.comboText', await evaluate(cdp, "!!window.G.viewport.querySelector('#tea-mood-text')"));
    await evaluate(cdp, "closeTeaSelect()");

    /* 6. Story window visuals */
    await evaluate(cdp, "openStoryWindow()");
    check('story.window', await waitFor(cdp, "!!window.G.swEl && !!window.G.viewport.querySelector('#game-story-win')", 5000));
    check('story.sprite', await evaluate(cdp, "!!window.G.viewport.querySelector('#sw-sprite') && !!window.G.viewport.querySelector('#sw-bubble')"));
    await evaluate(cdp, "closeStoryWindow()");
    check('story.close', await evaluate(cdp, "window.G.swEl === null || !window.G.swEl.isConnected"));

    /* 7. Dialogue engine: pagination + typewriter (clean state first) */
    await evaluate(cdp, "try{ closeDialogue(); }catch(e){} try{ exitSui(); }catch(e){}");
    await new Promise(resolve => setTimeout(resolve, 500));
    const pageCount = await evaluate(cdp, "paginateDialogue('这是一段用于分页测试的较长文本。'.repeat(30)).length");
    check('dialogue.pagination', pageCount >= 2, 'pages=' + pageCount);
    await evaluate(cdp, "showDialogue('Sui', ['测试对话'], function(){ window.__smoke_dlg_done = 1; })");
    check('dialogue.show', await ffUntil(cdp, "window.__smoke_dlg_done === 1"));
    check('dialogue.text', await evaluate(cdp, "window.G.viewport.querySelector('#game-dlg-text').textContent === '测试对话'"));
    check('dialogue.name', await evaluate(cdp, "window.G.viewport.querySelector('#game-dlg-name').textContent === 'Sui'"));
    await evaluate(cdp, "closeDialogue()");

    /* 8. Sui Q&A choices (intro dialogue is typewritten, fast-forward it) */
    await evaluate(cdp, "try{ closeDialogue(); }catch(e){}");
    await new Promise(resolve => setTimeout(resolve, 400));
    await evaluate(cdp, "document.querySelector('#game-sidebar [data-action=\"sui\"]').click()");
    check('sui.choices', await ffUntil(cdp, "!!window.G.viewport.querySelector('#game-choices') && window.G.viewport.querySelector('#game-choices').querySelectorAll('button').length >= 2"));
    await evaluate(cdp, "exitSui()");

    /* 9. Walking (state machine + pathfinding run) */
    await evaluate(cdp, "window.G.path = []; window.G.state = 'idle'; startWalkTo(600, 650, {});");
    await new Promise(resolve => setTimeout(resolve, 1200));
    const walkResult = await evaluate(cdp, "({ state: window.G.state, moved: Math.hypot(window.G.charX - 350, window.G.charY - 550) })");
    check('walk.ran', walkResult.state === 'walking' || walkResult.moved > 20, JSON.stringify(walkResult));
    await evaluate(cdp, "window.G.path = []; window.G.state = 'idle'; window.G.targetX = null; window.G.targetY = null;");

    /* 10. Save / load roundtrip */
    await evaluate(cdp, "saveState()");
    check('save.localStorage', await waitFor(cdp, "!!localStorage.getItem('suiGameState')", 5000));
    check('save.shape', await evaluate(cdp, "JSON.parse(localStorage.getItem('suiGameState')).outfitIdx === 2"));

    /* 11. Theme observer day/night crossfade */
    await evaluate(cdp, "document.body.classList.add('theme-infernal')");
    check('theme.night', await waitFor(cdp, "window.G.viewport && window.G.viewport.querySelector('.game-bg-night').style.opacity === '1'", 5000));
    await evaluate(cdp, "document.body.classList.remove('theme-infernal')");
    check('theme.day', await waitFor(cdp, "window.G.viewport.querySelector('.game-bg-day').style.opacity === '1'", 5000));

    /* 12. Pet mini window (requires a settled state: no dialogue / tarot / wardrobe / sui) */
    await evaluate(cdp, "try{ closeDialogue(); }catch(e){} try{ closeWardrobe(); }catch(e){} try{ closeTarot(); }catch(e){}");
    check('pet.preconditions', await waitFor(cdp, "!window.G.dialogueActive && !window.G.tarotOpen && !window.G.wardrobeOpen && !window.G.tourActive", 5000));
    await evaluate(cdp, "document.getElementById('game-pet-enter').click()");
    check('pet.open', await waitFor(cdp, "window.G.petMode === true && document.getElementById('game-pet-window').classList.contains('show')", 8000));
    await evaluate(cdp, "document.getElementById('pet-exit-btn').click()");
    check('pet.close', await waitFor(cdp, "window.G.petMode === false && !document.getElementById('game-pet-window').classList.contains('show')", 5000));

    /* 13. No uncaught exceptions referencing the game modules */
    const gameErrors = exceptions.filter(text => /game_|game_module|SuiGame|ReferenceError|TypeError/.test(text));
    check('runtime.noGameExceptions', gameErrors.length === 0, gameErrors.join(' || ').slice(0, 300));
    console.log('  INFO  exceptions captured: ' + exceptions.length + (exceptions.length ? ' (non-game related tolerated)' : ''));
  } finally {
    if (cdp) cdp.close();
    try { browser.kill(); } catch (error) { /* ignore */ }
  }

  console.log(failures === 0 ? '\nGame smoke test passed ✔' : '\nGame smoke test FAILED ✘');
  process.exit(failures ? 1 : 0);
}

main().catch(error => { console.error(error); process.exit(1); });
