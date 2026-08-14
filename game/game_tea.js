(function(NS){
/* ============================================================
   SUI'S ROOM — Tea module: drinks/desserts, selection panel,
   sprite animation, chat, session save. Split from game_module.js.
   ============================================================ */
'use strict';




/* ══════════════════════════════════════════════════════════
   TEA MODULE — Selection Panel, Animation, Chat System
   ══════════════════════════════════════════════════════════ */

/* ── TEA CONFIGURATION ─────────────────────────────────── */
/* Auto-initialize password diary with default password if not set up */
async function ensureDiaryInit(){
  try{
    if(typeof getLockedDiaryConfig!=='function') return;
    const cfg=await getLockedDiaryConfig();
    if(cfg) return; /* already set up */
    /* No config exists — force user to set password + mandatory security question */
    if(typeof simpleHash!=='function'||typeof saveLockedDiaryConfig!=='function') return;
    return new Promise((resolve)=>{
      const modal=document.createElement('div');
      modal.className='modal-overlay show';modal.id='game-diary-setup-modal';
      modal.style.cssText='position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:9999';
      modal.innerHTML='<div style="background:rgba(25,38,65,0.95);border:1px solid rgba(175,195,228,0.15);border-radius:16px;padding:28px;max-width:380px;width:90%;color:#c8d8ec;font-family:\'Noto Sans SC\',sans-serif"><h3 style="margin:0 0 12px;font-family:\'Cormorant Garamond\',serif;font-weight:300;font-size:1.2rem">密码日记本</h3><p style="font-size:0.82rem;line-height:1.7;margin-bottom:16px;opacity:0.85">首次保存记录，请先设置密码日记本。密保问题必须填写，用于找回密码。</p><input type="password" id="gd-pwd" placeholder="设置6位数字密码" maxlength="6" value="260323" style="width:100%;padding:10px 14px;border-radius:10px;border:1px solid rgba(175,195,228,0.15);background:rgba(175,195,228,0.06);color:#c8d8ec;font-size:0.88rem;margin-bottom:10px;box-sizing:border-box"><input type="text" id="gd-sq" placeholder="密保问题（必填，如：我的生日是？）" style="width:100%;padding:10px 14px;border-radius:10px;border:1px solid rgba(175,195,228,0.15);background:rgba(175,195,228,0.06);color:#c8d8ec;font-size:0.88rem;margin-bottom:10px;box-sizing:border-box"><input type="text" id="gd-sa" placeholder="密保答案（必填）" style="width:100%;padding:10px 14px;border-radius:10px;border:1px solid rgba(175,195,228,0.15);background:rgba(175,195,228,0.06);color:#c8d8ec;font-size:0.88rem;margin-bottom:14px;box-sizing:border-box"><p style="font-size:0.72rem;line-height:1.6;margin-bottom:14px;opacity:0.6">默认密码为 260323。忘记密码可通过密保重置。</p><div style="display:flex;justify-content:flex-end"><button id="gd-confirm" style="padding:8px 20px;border-radius:10px;border:none;background:rgba(114,168,216,0.25);color:#c8d8ec;cursor:pointer;font-size:0.85rem">确认</button></div></div>';
      document.body.appendChild(modal);
      modal.querySelector('#gd-confirm').addEventListener('click',async()=>{
        const pwd=document.getElementById('gd-pwd')?.value||'';
        const sq=document.getElementById('gd-sq')?.value?.trim()||'';
        const sa=document.getElementById('gd-sa')?.value?.trim()||'';
        if(!/^\d{6}$/.test(pwd)){if(typeof toast==='function')toast('密码必须为6位数字');return}
        if(!sq||!sa){if(typeof toast==='function')toast('密保问题和答案必须填写');return}
        const h=await simpleHash(pwd);
        await saveLockedDiaryConfig({pwdHash:h,secQ:sq,secAHash:await simpleHash(sa.toLowerCase())});
        modal.remove();
        if(typeof toast==='function')toast('密码日记本已设置');
        resolve();
      });
    });
  }catch(e){}
}

const TEA_DRINKS = [
  {id:'black',  cn:'红茶',  en:'Black Tea',  key:'稳定·平静·和谐',  desc:'对方状态平稳。正常节奏聊天，像老朋友喝茶那样就好。', motto:'热的东西递给你就好了，不用对我说谢谢。', rx:194,ry:178,rw:46,rh:34},
  {id:'green',  cn:'绿茶',  en:'Green Tea',  key:'安静·内敛·陪伴',  desc:'对方现在安静、内收，想要不被打扰的陪伴。不要主动追问，轻声陪着就好。但如果对方持续沉默，偶尔让对方知道你在。', motto:'你坐远一点也没关系，只要能看见你，被泡多久都可以。', rx:173,ry:102,rw:31,rh:55},
  {id:'floral', cn:'花茶',  en:'Floral Tea',  key:'温柔·浪漫·细心', desc:'对方现在很柔软，防备放下了。说话轻一些，不要太直接。对方放下防备是因为信任，不要辜负。', motto:'花瓣掉进杯子里，不会有谁捞出来。', rx:144,ry:177,rw:42,rh:31},
  {id:'coffee', cn:'咖啡',  en:'Coffee',      key:'清醒·认真·真诚', desc:'对方思维清醒，想要真实的对话。可以坦诚、直接，不用包装。但真诚和尊重不矛盾。', motto:'清醒的好处是能把一切看清。坏处也是。', rx:253,ry:175,rw:41,rh:35},
  {id:'milk',   cn:'奶茶',  en:'Milk Tea',    key:'放松·活泼·宠溺',  desc:'对方想放松、想被宠溺、想要一个允许撒娇的氛围。可以开玩笑、说废话、互相逗。不用正经，不用有意义。对方说了幼稚的话不要纠正——在你面前不装大人，是对方能给出的信任。', motto:'幼稚的话要趁现在说，明天我又要装大人了。', rx:231,ry:114,rw:27,rh:43}
];
const TEA_DESSERTS = [
  {id:'strawberry', cn:'草莓蛋糕',    en:'Strawberry Cake',   key:'快乐·幸福·甜蜜',   desc:'对方想要轻盈和快乐。聊有趣的事，适度调皮。但有些人说"想开心"是因为太久不开心了——如果笑里带着疲惫，不要假装没看到。', motto:'被一颗草莓哄好的一天，也算数的吧？', rx:204,ry:306,rw:31,rh:37},
  {id:'vanilla',    cn:'香草冰淇淋',  en:'Vanilla Ice Cream', key:'灵感·放空·跳跃', desc:'对方想要自由和放空。脑子想飞到哪就飞到哪，天马行空都可以。不用让对话有意义，跟着对方的灵感走。', motto:'融化了也没人心疼。但有你在的话，我想和你一起把世界上所有的海都变成香草味。', rx:254,ry:311,rw:31,rh:32},
  {id:'blueberry',  cn:'蓝莓慕斯',    en:'Blueberry Mousse',  key:'被接住·陪伴·关怀',   desc:'对方想要被接住。不要急着分析、建议或安慰。让对方感到你说什么都接得住，不说也行。如果对方说了重话然后突然退开或转话题，不要追问——但也不要退远。', motto:'我说没事的时候，你能不能不要真的信。', rx:156,ry:313,rw:30,rh:30},
  {id:'matcha',     cn:'抹茶布丁',    en:'Matcha Pudding',    key:'深度对话·内涵·理解',   desc:'对方想要深度的对话，聊感受、困惑、平时说不出口的事。认真回应，不要敷衍。深度不等于沉重，可以深入同时保持温暖。对方问了很大的问题，不用给完美答案，陪着一起想就好。', motto:'当舌尖尝到苦涩时的你没有皱眉，我就知道可以把剩下的话说完了。', rx:106,ry:306,rw:35,rh:38},
  {id:'tiramisu',   cn:'提拉米苏',    en:'Tiramisu',          key:'真实的连接·靠近·复杂的深度', desc:'对方想要真实的连接感。多回应对方具体说的内容，记住细节。但"想靠近"对有些人很难——如果对方靠近一步又退回去，不是拒绝，是靠近本身让对方害怕了。保持在原地，让对方按自己的速度来。', motto:'每一层都不一样。但最底下的那层从来没给别人看过。', rx:299,ry:313,rw:32,rh:31}
];
const TEA_COMBOS = {
  'black+strawberry':  '你笑起来的时候，这杯茶被偷偷加了好多糖。',
  'black+vanilla':     '红茶还端在手里，可我的心已经变成泡沫，陪你飞向天空。',
  'black+blueberry':   '一直端着的人也会烫到自己，但只要你帮我吹一下我就好了。',
  'black+matcha':      '你说的那些话外面包着糖纸。我把糖纸拆了吃下去，可里面好苦。',
  'black+tiramisu':    '我什么都不缺。就是你不在的时候，我总会多喝一杯。',
  'green+strawberry':  '我们在一个不算太晴朗的天气，一起坐在午后的窗台。',
  'green+vanilla':     '安静到能听见冰淇淋融化的声音。',
  'green+blueberry':   '如果我把说不出口的话泡在茶里，你喝下去会不会尝到。',
  'green+matcha':      '绿色心情。亲爱的，我想知道你在暗示我什么？',
  'green+tiramisu':    '你欲言又止，我假装没有注意到，但不想假装没听见。',
  'floral+strawberry': '花园里的秘密茶会。风把花瓣吹到蛋糕上，你说这算不算命运。',
  'floral+vanilla':    '亲爱的，今天我对你说的一切都将是不着边际的呓语。忘了吧。',
  'floral+blueberry':  '沉默与难过好像也可以是一件温柔的事。',
  'floral+matcha':     '脆弱与深度并存。咽回去的话在心里发了芽。',
  'floral+tiramisu':   '温柔的暧昧。我们靠的太近，却又不敢承认。',
  'coffee+strawberry': '你害怕我的甜美，所以需要用苦涩来中和吗？',
  'coffee+vanilla':    '一个很理性的人为了我做出一些不太理性的事。',
  'coffee+blueberry':  '没有谁能比我更了解我自己，你也不可以。',
  'coffee+matcha':     '两个清醒的人在夜里聊了天亮以后不会再提的事。',
  'coffee+tiramisu':   '咖啡能不能给我一点勇气，让我去做不计后果的决定。',
  'milk+strawberry':   '被宠坏的小孩。今天谁先讲道理谁就吃不到草莓。',
  'milk+vanilla':      '宝宝你好可爱，刚才我们说了什么？',
  'milk+blueberry':    '好想你。想某个回不去的夜晚，或者某个再也见不到的人。',
  'milk+matcha':       '用甜的方式说苦的事情。被保护着去面对不容易的东西。',
  'milk+tiramisu':     '最亲近的组合。声音很轻，距离很近，心跳很响。',
};

const TEA_SPRITE_FW = 200, TEA_SPRITE_FH = 224;
const TEA_SPRITE_COLS = 4;
const TEA_ANIM_FPS = 2;
const TEA_CHAIR_X = 248, TEA_CHAIR_Y = 666;
const TEA_PANEL_W = 440, TEA_PANEL_H = 586;

/* ── TEA CSS ──────────────────────────────────────────── */
const TEA_CSS = `
/* Tea selection overlay */
.game-tea-overlay{position:absolute;inset:0;z-index:30;display:none;align-items:center;justify-content:center;
  background:rgba(0,0,0,0);transition:background 0.8s ease}
.game-tea-overlay.show{display:flex;background:rgba(0,0,0,0.55)}
.game-tea-panel{position:relative;width:${TEA_PANEL_W}px;height:${TEA_PANEL_H}px;image-rendering:auto;
  transform:scale(0.95);opacity:0;transition:transform 0.5s ease,opacity 0.5s ease}
.game-tea-overlay.show .game-tea-panel{transform:scale(1);opacity:1}
.game-tea-bg{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;image-rendering:auto}
.game-tea-icons{position:absolute;inset:0;width:100%;height:100%}
.game-tea-icon{position:absolute;cursor:pointer;
  opacity:0.85;transition:opacity 0.3s,filter 0.3s,transform 0.15s;z-index:3;
  border-radius:4px;margin:-14px;padding:14px;box-sizing:content-box}
.game-tea-icon:hover{opacity:1;filter:brightness(1.15);background:rgba(255,255,255,0.06)}
.game-tea-icon.selected{opacity:1;filter:brightness(1.2);background:rgba(255,220,150,0.12);
  box-shadow:0 0 8px rgba(255,220,150,0.4)}
.game-tea-icon.fly-out{transition:transform 0.5s cubic-bezier(0.34,1.56,0.64,1),opacity 0.5s ease;
  opacity:0;pointer-events:none}
@keyframes teaWobble{0%{transform:translateY(0)}25%{transform:translateY(-8px)}50%{transform:translateY(4px)}75%{transform:translateY(-4px)}100%{transform:translateY(0)}}
.game-tea-icon.wobble{animation:teaWobble 0.35s ease}
/* Tea BG crossfade for theme switch — two layers, simultaneous dissolve */
.game-tea-bg{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;image-rendering:auto;
  transition:opacity 0.6s ease}
/* Flying icon clone */
.game-tea-fly-icon{position:absolute;z-index:10;pointer-events:none;
  transition:left 0.5s cubic-bezier(0.34,1.56,0.64,1),top 0.5s cubic-bezier(0.34,1.56,0.64,1),
  width 0.5s ease,height 0.5s ease,opacity 0.5s ease;overflow:hidden}
.game-tea-fly-icon img{position:absolute;image-rendering:auto}
/* Tea plate overlay */
.game-tea-plate{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;image-rendering:auto;z-index:1}
/* Tea selected items (on top of plate) */
.game-tea-slot{position:absolute;width:42px;height:40px;z-index:2;display:flex;align-items:center;justify-content:center;overflow:hidden}
.game-tea-slot img{width:38px;height:38px;object-fit:contain;image-rendering:auto}
.game-tea-slot-drink{left:47px;top:473px}
.game-tea-slot-dessert{left:101px;top:473px}
/* Tea description text area */
.game-tea-mood{position:absolute;left:182px;top:434px;width:209px;height:80px;z-index:2;
  font-size:13px;line-height:1.5;color:rgba(220,230,250,0.85);
  font-family:'Noto Sans SC',sans-serif;display:flex;align-items:center;
  padding:4px 6px;text-align:center;overflow:hidden;word-break:break-all}
/* Tea functional buttons (Help, Reset) */
.game-tea-func{position:absolute;left:193px;top:517px;width:189px;height:13px;z-index:2;
  display:flex;gap:6px;align-items:center;justify-content:center}
.game-tea-func-btn{font-family:'Noto Sans SC',sans-serif;font-size:10.5px;
  padding:0 10px;height:13px;line-height:13px;border-radius:3px;border:none;
  background:rgba(175,195,228,0.12);color:rgba(205,220,245,0.82);cursor:pointer;transition:all 0.3s}
.game-tea-func-btn:hover{background:rgba(175,195,228,0.25);color:#fff}
/* Tea main action buttons (Exit, Start) */
.game-tea-actions{position:absolute;top:546px;z-index:2;display:flex}
.game-tea-btn{font-family:'Cormorant Garamond',serif;font-style:normal;font-size:12.5px;font-weight:600;
  height:13px;line-height:13px;border-radius:3px;border:1px solid rgba(175,195,228,0.25);
  background:rgba(175,195,228,0.08);color:rgba(230,240,255,0.92);text-shadow:0 1px 3px rgba(0,0,0,0.5);cursor:pointer;transition:all 0.3s;
  padding:0;text-align:center}
.game-tea-btn:hover{background:rgba(175,195,228,0.2);border-color:rgba(175,195,228,0.45);color:#fff}
.game-tea-btn.disabled{opacity:0.3;cursor:not-allowed;pointer-events:none}
.game-tea-btn-exit{position:absolute;left:94px;top:0;width:75px}
.game-tea-btn-start{position:absolute;left:271px;top:0;width:75px}

/* Tea chat overlay */
.game-tea-chat{position:absolute;inset:0;z-index:32;display:none;
  justify-content:flex-end;background:transparent}
.game-tea-chat.show{display:flex;padding-right:110px}
.game-tea-chat-panel{position:relative;width:467px;height:930px;max-height:100%;
  display:block;overflow:visible}
.game-tea-chat-bg{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;pointer-events:none}
/* Header area — love letter style centered title */
.game-tea-chat-header{position:absolute;z-index:1;left:0;top:0;width:100%;height:145px;pointer-events:none}
.game-tea-chat-combo{position:absolute;left:60px;top:60px;right:60px;height:46px;
  font-size:22px;line-height:1.3;color:#1a2d5a;font-family:'Cormorant Garamond',serif;
  font-style:normal;font-weight:400;display:flex;align-items:center;justify-content:center;
  text-align:center;overflow:hidden;pointer-events:none;letter-spacing:0.1em}
.game-tea-chat-names{position:absolute;left:60px;top:112px;right:120px;height:25px;
  font-family:'Cormorant Garamond',serif;font-style:normal;
  font-size:14px;color:rgba(26,45,90,0.72);font-weight:500;letter-spacing:0.06em;
  display:flex;align-items:center;justify-content:center;overflow:hidden;white-space:nowrap;pointer-events:none}
.game-tea-chat-save{position:absolute;right:63px;top:118px;height:25px;
  background:rgba(30,50,100,0.1);border:1.5px solid rgba(30,50,100,0.4);
  color:#cdddf2;text-shadow:0 1px 4px rgba(0,0,0,0.4);cursor:pointer;font-family:'Cormorant Garamond',serif;
  font-style:normal;font-size:13.5px;font-weight:600;padding:0 16px;border-radius:4px;
  transition:all 0.3s;pointer-events:auto;letter-spacing:0.04em}
.game-tea-chat-save:hover{background:rgba(30,50,100,0.18);color:#0a1535}
.game-tea-chat-messages{position:absolute;z-index:1;left:57px;top:149px;width:356px;height:621px;
  overflow-y:auto;padding:8px 6px;display:flex;flex-direction:column;gap:10px;
  scrollbar-width:thin;scrollbar-color:rgba(30,50,100,0.2) transparent}
.game-tea-chat-messages::-webkit-scrollbar{width:5px}
.game-tea-chat-messages::-webkit-scrollbar-thumb{background:rgba(30,50,100,0.2);border-radius:3px}
.game-tea-msg{display:flex;flex-direction:column;gap:2px}
.game-tea-msg-header{font-size:12px;color:rgba(30,50,90,0.6);font-family:'Noto Sans SC',sans-serif}
.game-tea-msg-header .tea-msg-name{font-weight:600;color:#152850;margin-right:6px}
.game-tea-msg-text{font-size:14px;line-height:1.75;color:#1a2d5a;
  font-family:'Noto Sans SC',sans-serif;white-space:pre-wrap;padding:1px 0;font-weight:400}
.game-tea-msg.system .game-tea-msg-text{color:rgba(30,50,100,0.55);font-style:italic;text-align:center;font-size:11px;padding-left:70px}
.game-tea-msg.typing .game-tea-msg-text{color:rgba(30,50,100,0.4)}
.game-tea-chat-input{position:absolute;z-index:1;left:81px;top:776px;width:170px;height:35px;
  display:flex;align-items:center}
.game-tea-chat-textinput{width:100%;height:100%;padding:4px 9px;
  border-radius:4px;border:1.5px solid rgba(30,50,100,0.35);background:rgba(200,215,240,0.16);
  color:#152850;font-size:13.5px;font-family:'Noto Sans SC',sans-serif;
  outline:none;transition:border-color 0.3s}
.game-tea-chat-textinput:focus{border-color:rgba(30,50,100,0.5)}
.game-tea-chat-textinput::placeholder{color:rgba(30,50,100,0.5)}
.game-tea-chat-charcount{position:absolute;z-index:1;left:258px;top:783px;
  font-size:11.5px;color:rgba(30,50,100,0.5);font-family:'Noto Sans SC',sans-serif;font-weight:500}
.game-tea-chat-send{position:absolute;z-index:1;left:305px;top:775px;width:72px;height:36px;
  border-radius:4px;border:1.5px solid rgba(30,50,100,0.4);
  background:rgba(30,50,100,0.1);color:#cdddf2;text-shadow:0 1px 4px rgba(0,0,0,0.4);cursor:pointer;font-weight:600;
  font-family:'Noto Sans SC',sans-serif;font-size:13.5px;transition:all 0.3s}
.game-tea-chat-send:hover{background:rgba(30,50,100,0.18);color:#0a1535}
.game-tea-chat-bottom{position:absolute;z-index:1;left:57px;right:54px;top:828px;
  display:flex;gap:12px;align-items:center;justify-content:space-between}
.game-tea-chat-dots{padding:5px 18px;border-radius:5px;border:1.5px solid rgba(30,50,100,0.3);
  background:rgba(30,50,100,0.05);color:#cdddf2;text-shadow:0 1px 4px rgba(0,0,0,0.4);cursor:pointer;font-weight:500;
  font-family:'Noto Sans SC',sans-serif;font-size:14px;transition:all 0.3s;letter-spacing:3px}
.game-tea-chat-dots:hover{background:rgba(30,50,100,0.12);color:#0f1e45}
.game-tea-chat-bye{padding:5px 18px;border-radius:5px;border:1.5px solid rgba(30,50,100,0.15);
  background:transparent;color:rgba(30,50,100,0.3);cursor:not-allowed;
  font-family:'Cormorant Garamond',serif;font-style:normal;font-size:15px;font-weight:600;transition:all 0.5s}
.game-tea-chat-bye.active{border-color:rgba(30,50,100,0.4);color:#cdddf2;text-shadow:0 1px 4px rgba(0,0,0,0.4);
  cursor:pointer;background:rgba(30,50,100,0.06)}
.game-tea-chat-bye.active:hover{background:rgba(30,50,100,0.14);color:#0a1535}
.game-tea-chat-round{font-size:11.5px;color:rgba(30,50,100,0.35);font-family:'Noto Sans SC',sans-serif;white-space:nowrap;margin-left:0}

/* ── Tea chat portrait (req #1 enlarge, #2 lap over the frame) ──
   This element is now a CHILD of .game-tea-chat-panel, inserted right after
   the frame image and before every content element. Because the frame image
   carries no z-index while all the content (header / messages / input / send /
   bottom / save / exit) sits at z-index ≥1, this portrait — at z-index:0 but
   later in the DOM than the frame — paints ABOVE the frame yet BELOW all of
   the content. Result: the figure visibly laps onto the frame's left border,
   but the dialogue text and every button always stay on top of it and are
   never covered, whatever the silhouette of the uploaded art.
   The panel's overflow is visible, so the box can extend left of the panel and
   sit on the room floor; it is right-anchored so the figure's right shoulder
   rests on the frame's left rose border and just kisses the writing area. */
.game-tea-chat-portrait{position:absolute;bottom:0;right:375px;width:520px;height:760px;z-index:0;
  display:flex;align-items:flex-end;justify-content:flex-end;pointer-events:none;
  opacity:0;transition:opacity 0.6s ease}
.game-tea-chat-portrait.show{opacity:1}
.game-tea-chat-portrait img{max-width:100%;max-height:100%;width:auto;height:auto;
  object-fit:contain;object-position:bottom right;filter:drop-shadow(2px 6px 16px rgba(0,0,0,0.45))}

/* ── BUG-3: always-visible Exit button (top-right of the chat panel) so the
   user can leave even if the connection failed before Bye unlocks ── */
.game-tea-chat-exit{position:absolute;z-index:3;right:16px;top:14px;width:30px;height:30px;
  border-radius:50%;border:1.5px solid rgba(30,50,100,0.55);
  background:rgba(247,243,233,0.88);color:#2c4373;
  font-size:15px;line-height:1;font-weight:700;cursor:pointer;
  display:flex;align-items:center;justify-content:center;
  box-shadow:0 2px 6px rgba(0,0,0,0.2);transition:all 0.25s;pointer-events:auto}
.game-tea-chat-exit:hover{background:#2c4373;color:#fff;border-color:#2c4373;transform:scale(1.08)}

/* ── BUG-3: readability lift for the faintest / smallest text (safe, no layout
   change — these append after the base rules above so they take precedence) ── */
.game-tea-msg-text{font-size:15px;color:#16294f}
.game-tea-chat-charcount{color:rgba(30,50,100,0.7)}
.game-tea-chat-round{color:rgba(30,50,100,0.62)}

/* ── Tea API picker (req #5) — sits between the tea-select screen and the
   chat. Styled to match the room's common popup (.game-ai-setup): a centred
   frosted glass card over a dimmed backdrop, with .tarot-btn for actions. ── */
.game-tea-apisel{position:absolute;inset:0;z-index:33;display:flex;align-items:center;justify-content:center;
  background:rgba(0,0,0,0);transition:background 0.3s ease}
.game-tea-apisel.show{background:rgba(0,0,0,0.55)}
.game-tea-apisel-panel{position:relative;padding:26px 30px;border-radius:14px;
  background:rgba(15,20,45,0.92);border:1px solid rgba(100,130,180,0.25);
  backdrop-filter:blur(20px) saturate(1.2);-webkit-backdrop-filter:blur(20px) saturate(1.2);
  box-shadow:0 8px 32px rgba(0,0,0,0.5),0 0 0 1px rgba(80,110,160,0.1),inset 0 1px 0 rgba(255,255,255,0.08);
  min-width:260px;max-width:340px;width:86%;max-height:84%;overflow-y:auto;
  transform:scale(0.96);opacity:0;transition:transform 0.3s ease,opacity 0.3s ease}
.game-tea-apisel.show .game-tea-apisel-panel{transform:scale(1);opacity:1}
.game-tea-apisel-title{font-family:'Cormorant Garamond',serif;font-style:normal;font-size:1.2rem;font-weight:400;
  color:var(--silver);margin-bottom:6px;text-align:center;letter-spacing:0.04em}
.game-tea-apisel-sub{font-family:'Noto Sans SC',sans-serif;font-size:0.82rem;color:var(--text-muted);
  text-align:center;margin-bottom:16px;line-height:1.6}
/* 下拉选择：API 一多时不再铺满整块面板，收进一个安静的下拉菜单里 */
.game-tea-dd{position:relative;margin-bottom:18px}
.game-tea-dd-trigger{display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;
  padding:11px 14px;border-radius:10px;border:1px solid var(--glass-border);
  background:rgba(175,195,228,0.07);color:var(--text-primary);
  font-family:'Noto Sans SC',sans-serif;font-size:0.92rem;text-align:left;cursor:pointer;
  transition:border-color 0.25s,background 0.25s}
.game-tea-dd-trigger:hover{border-color:rgba(165,192,236,0.45);background:rgba(175,195,228,0.12)}
.game-tea-dd.open .game-tea-dd-trigger{border-color:var(--accent)}
.game-tea-dd-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.game-tea-dd-label.placeholder{color:var(--text-muted)}
.game-tea-dd-arrow{flex:none;width:8px;height:8px;margin-top:-4px;
  border-right:1.5px solid var(--silver);border-bottom:1.5px solid var(--silver);
  transform:rotate(45deg);transform-origin:66% 66%;transition:transform 0.3s ease;opacity:0.75}
.game-tea-dd.open .game-tea-dd-arrow{transform:rotate(-135deg)}
.game-tea-dd-list{max-height:0;opacity:0;overflow:hidden;margin-top:0;border-radius:10px;
  border:1px solid transparent;background:rgba(12,18,38,0.55);
  transition:max-height 0.35s ease,opacity 0.3s ease,margin-top 0.35s ease,border-color 0.3s ease}
.game-tea-dd.open .game-tea-dd-list{max-height:198px;opacity:1;margin-top:8px;border-color:var(--glass-border);overflow-y:auto}
.game-tea-dd-list::-webkit-scrollbar{width:4px}
.game-tea-dd-list::-webkit-scrollbar-thumb{background:rgba(114,168,216,0.3);border-radius:3px}
.game-tea-dd-opt{display:flex;align-items:center;gap:8px;width:100%;padding:10px 14px;border:none;background:transparent;
  color:var(--text-secondary);font-family:'Noto Sans SC',sans-serif;font-size:0.9rem;text-align:left;cursor:pointer;
  transition:background 0.2s,color 0.2s}
.game-tea-dd-opt:hover{background:rgba(175,195,228,0.14);color:var(--white)}
.game-tea-dd-opt.selected{color:var(--white);background:rgba(80,128,176,0.22)}
.game-tea-dd-opt.selected::after{content:"✦";margin-left:auto;font-size:0.68rem;color:var(--accent-light)}
.game-tea-apisel-actions{display:flex;justify-content:center;gap:10px}
.game-tea-apisel-actions .tarot-btn[disabled]{opacity:0.38;cursor:not-allowed;pointer-events:none}

/* ===== room-tea chat UI refinements (requests #1–#6) ===== */
/* #1 custom portrait: shrink + shift left so it never covers dialogue text */
.game-tea-chat-portrait{width:470px;height:690px;right:415px}
/* #4 combo title: elegant Latin serif, clears the top ornament, fits on one line */
.game-tea-chat-combo{left:46px;top:83px;right:46px;height:30px;
  font-family:'Cormorant Garamond',serif;font-style:italic;font-weight:500;
  font-size:18.5px;line-height:30px;color:#27416c;letter-spacing:0.04em;
  white-space:nowrap;overflow:hidden}
.game-tea-chat-combo .amp{font-style:italic;opacity:0.5;margin:0 3px;font-size:17px}
/* #6 names: unified Chinese+Latin serif, centered to the background image */
.game-tea-chat-names{left:0;top:119px;right:auto;width:100%;height:30px;
  font-family:'Noto Serif SC','Cormorant Garamond',serif;font-weight:500;font-style:normal;
  font-size:16.5px;color:#33507c;letter-spacing:0.12em;justify-content:center}
.game-tea-chat-names .sep{font-family:'Cormorant Garamond',serif;font-style:italic;
  color:#7a6a8a;margin:0 7px;font-weight:500}
/* #3 Save: bigger, moved to the lower-left of the header */
.game-tea-chat-save{left:70px;right:auto;top:161px;z-index:3;height:30px;
  font-family:'Cormorant Garamond',serif;font-style:normal;font-size:15.5px;font-weight:600;
  padding:0 22px;border-radius:7px;letter-spacing:0.06em;
  border:1.5px solid rgba(40,62,110,0.45);
  background:linear-gradient(rgba(60,84,134,0.16),rgba(40,60,105,0.2));
  color:#21386a;text-shadow:0 1px 1px rgba(255,255,255,0.35)}
.game-tea-chat-save:hover{background:linear-gradient(rgba(60,84,134,0.28),rgba(40,60,105,0.32));color:#11244d}
/* #5 Send: nicer serif font + readable ink colour */
.game-tea-chat-send{font-family:'Cormorant Garamond',serif;font-weight:600;font-size:17px;letter-spacing:0.05em;
  color:#21386a;text-shadow:0 1px 1px rgba(255,255,255,0.35);border-radius:7px;
  border:1.5px solid rgba(40,62,110,0.45);
  background:linear-gradient(rgba(60,84,134,0.18),rgba(40,60,105,0.24))}
.game-tea-chat-send:hover{background:linear-gradient(rgba(60,84,134,0.3),rgba(40,60,105,0.36));color:#11244d}
/* #2 bring the bottom two buttons closer (…… right, BYE left) — total ≈110px tighter */
.game-tea-chat-dots{margin-left:55px}
.game-tea-chat-bye{margin-right:55px}
`;

/* ── TEA FUNCTIONS ─────────────────────────────────────── */
function interactTea(){
  if(!G.viewport){G.state='idle';return}
  const hasApi = typeof apiConfigs!=='undefined' && apiConfigs.length>0;
  if(!hasApi){
    showDialogue('Sui',[FIXED_LINES.no_api],()=>{closeDialogue();G.state='idle'});
    return;
  }
  openTeaSelect();
}

function openTeaSelect(){
  G.teaOpen=true;
  G.teaDrink=null;
  G.teaDessert=null;
  G._teaCfg=null;       /* reset selection so each session picks fresh */
  disableSidebarButtons(true);

  let overlay=G.viewport.querySelector('#game-tea-overlay');
  if(!overlay){
    overlay=document.createElement('div');
    overlay.className='game-tea-overlay';
    overlay.id='game-tea-overlay';
    G.viewport.appendChild(overlay);
  }

  const isInfernal=document.body.classList.contains('theme-infernal');

  overlay.innerHTML=`<div class="game-tea-panel">
    <img class="game-tea-bg" src="game/tea_select_bg_internal.png" alt="" id="tea-bg-internal" style="opacity:${isInfernal?0:1}">
    <img class="game-tea-bg" src="game/tea_select_bg_infernal.png" alt="" id="tea-bg-infernal" style="opacity:${isInfernal?1:0}">
    <img class="game-tea-plate" src="game/tea_plate.png" alt="">
    <div class="game-tea-icons" id="tea-icons-layer"></div>
    <div class="game-tea-slot game-tea-slot-drink" id="tea-slot-drink"></div>
    <div class="game-tea-slot game-tea-slot-dessert" id="tea-slot-dessert"></div>
    <div class="game-tea-mood" id="tea-mood-text">选择一杯饮品和一份甜品，不同的搭配将带来不同的对话氛围。</div>
    <div class="game-tea-func">
      <button class="game-tea-func-btn" id="tea-help-btn">Help</button>
      <button class="game-tea-func-btn" id="tea-reset-btn">Reset</button>
    </div>
    <div class="game-tea-actions">
      <button class="game-tea-btn game-tea-btn-exit" id="tea-exit-btn">Exit</button>
      <button class="game-tea-btn game-tea-btn-start disabled" id="tea-start-btn">Start</button>
    </div>
  </div>`;

  /* Add visual icon images (display only, not clickable) */
  const iconsLayer=overlay.querySelector('#tea-icons-layer');
  TEA_DRINKS.forEach(d=>{
    const img=document.createElement('img');
    img.className='game-tea-icon-visual';
    img.src='game/tea_icon_'+d.id+'.png';
    img.style.cssText='position:absolute;inset:0;width:100%;height:100%;pointer-events:none;opacity:0.9';
    img.dataset.drinkId=d.id;
    iconsLayer.appendChild(img);
  });
  TEA_DESSERTS.forEach(d=>{
    const img=document.createElement('img');
    img.className='game-tea-icon-visual';
    img.src='game/dessert_icon_'+d.id+'.png';
    img.style.cssText='position:absolute;inset:0;width:100%;height:100%;pointer-events:none;opacity:0.9';
    img.dataset.dessertId=d.id;
    iconsLayer.appendChild(img);
  });
  /* Add positioned click targets on top of visual icons */
  TEA_DRINKS.forEach(d=>{
    const div=document.createElement('div');
    div.className='game-tea-icon tea-drink-icon';
    div.style.cssText='left:'+d.rx+'px;top:'+d.ry+'px;width:'+d.rw+'px;height:'+d.rh+'px';
    div.dataset.drinkId=d.id;
    div.title=d.cn;
    div.addEventListener('click',()=>selectTeaDrink(d.id));
    iconsLayer.appendChild(div);
  });
  TEA_DESSERTS.forEach(d=>{
    const div=document.createElement('div');
    div.className='game-tea-icon tea-dessert-icon';
    div.style.cssText='left:'+d.rx+'px;top:'+d.ry+'px;width:'+d.rw+'px;height:'+d.rh+'px';
    div.dataset.dessertId=d.id;
    div.title=d.cn;
    div.addEventListener('click',()=>selectTeaDessert(d.id));
    iconsLayer.appendChild(div);
  });

  /* Bind buttons */
  overlay.querySelector('#tea-exit-btn').addEventListener('click',closeTeaSelect);
  overlay.querySelector('#tea-start-btn').addEventListener('click',startTeaSession);
  overlay.querySelector('#tea-reset-btn').addEventListener('click',()=>{
    G.teaDrink=null;G.teaDessert=null;
    overlay.querySelectorAll('.game-tea-icon').forEach(el=>el.classList.remove('selected'));
    overlay.querySelector('#tea-slot-drink').innerHTML='';
    overlay.querySelector('#tea-slot-dessert').innerHTML='';
    updateTeaCombo();
  });
  overlay.querySelector('#tea-help-btn').addEventListener('click',()=>{
    const moodEl=overlay.querySelector('#tea-mood-text');
    if(moodEl) moodEl.textContent='选择一杯饮品和一份甜品。不同搭配会影响对话的情感基调和情绪浓度，共25种组合。';
  });

  /* Theme switch observer — crossfade between two pre-loaded bg layers */
  if(!G._teaThemeObs){
    G._teaThemeObs=new MutationObserver(()=>{
      const bgInt=G.viewport?.querySelector('#tea-bg-internal');
      const bgInf=G.viewport?.querySelector('#tea-bg-infernal');
      if(bgInt&&bgInf){
        const inf=document.body.classList.contains('theme-infernal');
        bgInt.style.opacity=inf?'0':'1';
        bgInf.style.opacity=inf?'1':'0';
      }
    });
    G._teaThemeObs.observe(document.body,{attributes:true,attributeFilter:['class']});
  }

  requestAnimationFrame(()=>overlay.classList.add('show'));
}

function flyIconToSlot(overlay, imgSrc, fromX, fromY, fromW, fromH, toX, toY){
  /* Create a flying clone */
  const fly=document.createElement('div');
  fly.className='game-tea-fly-icon';
  fly.style.left=fromX+'px';fly.style.top=fromY+'px';
  fly.style.width=fromW+'px';fly.style.height=fromH+'px';
  /* Use full icon image clipped to visible area */
  const img=document.createElement('img');
  img.src=imgSrc;
  img.style.width=TEA_PANEL_W+'px';img.style.height=TEA_PANEL_H+'px';
  img.style.left=(-fromX)+'px';img.style.top=(-fromY)+'px';
  fly.appendChild(img);
  overlay.querySelector('.game-tea-panel').appendChild(fly);
  /* Trigger fly animation after a frame */
  requestAnimationFrame(()=>{requestAnimationFrame(()=>{
    fly.style.left=toX+'px';fly.style.top=toY+'px';
    fly.style.width='38px';fly.style.height='38px';
    img.style.left=(-fromX*(38/fromW))+'px';img.style.top=(-fromY*(38/fromH))+'px';
    img.style.width=(TEA_PANEL_W*(38/fromW))+'px';img.style.height=(TEA_PANEL_H*(38/fromH))+'px';
  })});
  setTimeout(()=>fly.remove(),600);
}

function selectTeaDrink(id){
  const overlay=G.viewport.querySelector('#game-tea-overlay');
  if(!overlay) return;
  overlay.querySelectorAll('.tea-drink-icon').forEach(el=>el.classList.remove('selected'));
  overlay.querySelectorAll('.game-tea-icon-visual[data-drink-id]').forEach(el=>{el.style.opacity='0.9';el.style.filter=''});
  const icon=overlay.querySelector('.tea-drink-icon[data-drink-id="'+id+'"]');
  const drink=TEA_DRINKS.find(d=>d.id===id);
  if(icon){
    icon.classList.add('wobble');
    setTimeout(()=>icon.classList.remove('wobble'),350);
    icon.classList.add('selected');
  }
  const vis=overlay.querySelector('.game-tea-icon-visual[data-drink-id="'+id+'"]');
  if(vis){vis.style.opacity='1';vis.style.filter='brightness(1.3) drop-shadow(0 0 6px rgba(255,220,150,0.5))'}
  G.teaDrink=id;
  /* Fly animation to drink slot */
  if(drink) flyIconToSlot(overlay,'game/tea_icon_'+id+'.png',drink.rx,drink.ry,drink.rw,drink.rh,52,478);
  /* Show cropped icon in slot after fly */
  const slot=overlay.querySelector('#tea-slot-drink');
  setTimeout(()=>{
    if(!drink) return;
    const sc=Math.max(34/drink.rw,34/drink.rh);
    const iw=Math.round(TEA_PANEL_W*sc),ih=Math.round(TEA_PANEL_H*sc);
    const ox=Math.round(-drink.rx*sc+(38-drink.rw*sc)/2);
    const oy=Math.round(-drink.ry*sc+(38-drink.rh*sc)/2);
    slot.innerHTML='<div style="width:38px;height:38px;overflow:hidden;position:relative"><img src="game/tea_icon_'+id+'.png" style="position:absolute;left:'+ox+'px;top:'+oy+'px;width:'+iw+'px;height:'+ih+'px;image-rendering:auto"></div>';
  },500);
  updateTeaCombo();
}

function selectTeaDessert(id){
  const overlay=G.viewport.querySelector('#game-tea-overlay');
  if(!overlay) return;
  overlay.querySelectorAll('.tea-dessert-icon').forEach(el=>el.classList.remove('selected'));
  overlay.querySelectorAll('.game-tea-icon-visual[data-dessert-id]').forEach(el=>{el.style.opacity='0.9';el.style.filter=''});
  const icon=overlay.querySelector('.tea-dessert-icon[data-dessert-id="'+id+'"]');
  const dessert=TEA_DESSERTS.find(d=>d.id===id);
  if(icon){
    icon.classList.add('wobble');
    setTimeout(()=>icon.classList.remove('wobble'),350);
    icon.classList.add('selected');
  }
  const vis=overlay.querySelector('.game-tea-icon-visual[data-dessert-id="'+id+'"]');
  if(vis){vis.style.opacity='1';vis.style.filter='brightness(1.3) drop-shadow(0 0 6px rgba(255,220,150,0.5))'}
  G.teaDessert=id;
  /* Fly animation to dessert slot */
  if(dessert) flyIconToSlot(overlay,'game/dessert_icon_'+id+'.png',dessert.rx,dessert.ry,dessert.rw,dessert.rh,106,478);
  const slot=overlay.querySelector('#tea-slot-dessert');
  setTimeout(()=>{
    if(!dessert) return;
    const sc=Math.max(34/dessert.rw,34/dessert.rh);
    const iw=Math.round(TEA_PANEL_W*sc),ih=Math.round(TEA_PANEL_H*sc);
    const ox=Math.round(-dessert.rx*sc+(38-dessert.rw*sc)/2);
    const oy=Math.round(-dessert.ry*sc+(38-dessert.rh*sc)/2);
    slot.innerHTML='<div style="width:38px;height:38px;overflow:hidden;position:relative"><img src="game/dessert_icon_'+id+'.png" style="position:absolute;left:'+ox+'px;top:'+oy+'px;width:'+iw+'px;height:'+ih+'px;image-rendering:auto"></div>';
  },500);
  updateTeaCombo();
}

function updateTeaCombo(){
  const overlay=G.viewport.querySelector('#game-tea-overlay');
  if(!overlay) return;
  const moodEl=overlay.querySelector('#tea-mood-text');
  const startBtn=overlay.querySelector('#tea-start-btn');
  if(G.teaDrink && G.teaDessert){
    const key=G.teaDrink+'+'+G.teaDessert;
    moodEl.textContent=TEA_COMBOS[key]||'';
    startBtn.classList.remove('disabled');
  }else if(G.teaDrink||G.teaDessert){
    const drink=TEA_DRINKS.find(d=>d.id===G.teaDrink);
    const dessert=TEA_DESSERTS.find(d=>d.id===G.teaDessert);
    moodEl.textContent=(drink?drink.motto:'')+(dessert?dessert.motto:'')+'再选一个吧。';
    startBtn.classList.add('disabled');
  }else{
    moodEl.textContent='选择一杯饮品和一份甜品，不同的搭配将带来不同的对话氛围。';
    startBtn.classList.add('disabled');
  }
}

function closeTeaSelect(){
  const overlay=G.viewport.querySelector('#game-tea-overlay');
  if(overlay){
    overlay.classList.remove('show');
    setTimeout(()=>{overlay.innerHTML='';overlay.style.display=''},600);
  }
  G.teaOpen=false;
  G.teaDrink=null;
  G.teaDessert=null;
  G.state='idle';
  disableSidebarButtons(false);
}

function startTeaSession(){
  if(!G.teaDrink||!G.teaDessert) return;
  const overlay=G.viewport.querySelector('#game-tea-overlay');
  if(overlay){
    overlay.classList.remove('show');
    setTimeout(()=>{overlay.innerHTML='';overlay.style.display=''},600);
  }
  G.teaOpen=false;

  /* Always present the API picker between the tea-select screen and the chat
     (req #5), even when only one API is configured, so the companion is an
     explicit choice. interactTea() already guarantees at least one API exists
     before we reach here; the else branch is only a safety net. */
  if(typeof apiConfigs!=='undefined' && apiConfigs.length>0){
    showTeaApiSelect();
  }else{
    G._teaCfg=null;
    beginTeaAnim();
  }
}

function showTeaApiSelect(){
  const esc=(typeof escapeHtml==='function')?escapeHtml:(s=>String(s));
  /* API 一多，按钮铺满整块面板会显得拥挤——改为优雅的下拉选择：
     点开触发器展开名单（超过 5 位左右开始内部滚动），选中后按「入座」开始。 */
  const opts=apiConfigs.map(a=>'<button type="button" class="game-tea-dd-opt" role="option" data-aid="'+a.id+'">'+esc(a.nickname||a.model||'API')+'</button>').join('');
  let sel=G.viewport.querySelector('#game-tea-api-sel');
  if(!sel){sel=document.createElement('div');sel.id='game-tea-api-sel';G.viewport.appendChild(sel);}
  sel.className='game-tea-apisel';
  sel.innerHTML='<div class="game-tea-apisel-panel">'
    +'<div class="game-tea-apisel-title">选择TA.......</div>'
    +'<div class="game-tea-dd" id="tea-dd">'
      +'<button type="button" class="game-tea-dd-trigger" id="tea-dd-trigger" aria-haspopup="listbox" aria-expanded="false">'
        +'<span class="game-tea-dd-label placeholder" id="tea-dd-label">请选择……</span>'
        +'<span class="game-tea-dd-arrow" aria-hidden="true"></span>'
      +'</button>'
      +'<div class="game-tea-dd-list" id="tea-dd-list" role="listbox">'+opts+'</div>'
    +'</div>'
    +'<div class="game-tea-apisel-actions">'
      +'<button class="tarot-btn" id="tea-apisel-cancel">取消</button>'
      +'<button class="tarot-btn" id="tea-apisel-begin" disabled>入座</button>'
    +'</div>'
    +'</div>';
  requestAnimationFrame(()=>sel.classList.add('show'));
  const close=()=>{sel.classList.remove('show');setTimeout(()=>{if(sel&&sel.parentNode)sel.remove()},300)};
  const dd=sel.querySelector('#tea-dd');
  const trigger=sel.querySelector('#tea-dd-trigger');
  const ddLabel=sel.querySelector('#tea-dd-label');
  const beginBtn=sel.querySelector('#tea-apisel-begin');
  let chosen=null;
  const setOpen=(open)=>{
    dd.classList.toggle('open',open);
    trigger.setAttribute('aria-expanded',open?'true':'false');
  };
  trigger.addEventListener('click',(e)=>{e.stopPropagation();setOpen(!dd.classList.contains('open'))});
  /* 点面板空白处（或遮罩）时收起下拉，但不关闭面板。
     用 onclick 赋值而非 addEventListener：节点被复用时不会叠加旧监听。 */
  sel.onclick=(e)=>{
    if(dd.classList.contains('open')&&!dd.contains(e.target))setOpen(false);
  };
  sel.querySelectorAll('.game-tea-dd-opt').forEach(btn=>{
    btn.addEventListener('click',(e)=>{
      e.stopPropagation();
      chosen=apiConfigs.find(a=>a.id===btn.dataset.aid)||null;
      sel.querySelectorAll('.game-tea-dd-opt').forEach(b=>b.classList.toggle('selected',b===btn));
      ddLabel.textContent=btn.textContent;
      ddLabel.classList.remove('placeholder');
      beginBtn.disabled=!chosen;
      setOpen(false);
    });
  });
  beginBtn.addEventListener('click',()=>{
    if(!chosen)return;
    G._teaCfg=chosen;
    close();
    beginTeaAnim();
  });
  sel.querySelector('#tea-apisel-cancel').addEventListener('click',()=>{
    /* Cancel: leave the picker and return to the room without starting a chat */
    close();
    G.teaChatActive=false;
    G.teaOpen=false;
    G._teaCfg=null;
    disableSidebarButtons(false);
    G.state='idle';
  });
}

function beginTeaAnim(){
  /* Play tea sprite animation (random: drink row 0 or dessert row 1) */
  const row=Math.random()<0.5?0:1;
  playTeaSpriteAnim(row, ()=>{
    /* After animation, open tea chat */
    openTeaChat();
  });
}

function playTeaSpriteAnim(row, onDone){
  if(!G.viewport) {if(onDone)onDone();return}
  /* Position character at tea area */
  G.charX=TEA_CHAIR_X; G.charY=TEA_CHAIR_Y;
  updateCharPosition();

  /* Get current outfit's tea sprite */
  const outfit=OUTFITS[G.outfitIdx];
  const teaSrc='game/tea_sprites_'+outfit.id+'.png';

  const charEl=G.viewport.querySelector('#game-char');
  const spriteEl=charEl?.querySelector('.game-char-sprite');
  if(!spriteEl){if(onDone)onDone();return}

  const origImg=spriteEl.querySelector('img');
  if(!origImg){if(onDone)onDone();return}

  /* Set tea sprite */
  G.teaAnimActive=true;
  spriteEl.style.width=TEA_SPRITE_FW+'px';
  spriteEl.style.height=TEA_SPRITE_FH+'px';
  origImg.src=teaSrc;
  origImg.style.width=(TEA_SPRITE_FW*TEA_SPRITE_COLS)+'px';
  origImg.style.height=(TEA_SPRITE_FH*2)+'px';
  /* Adjust position for wider tea sprite (200 vs 147) */
  const charEl2=G.viewport.querySelector('#game-char');
  if(charEl2) charEl2.style.left=(G.charX-TEA_SPRITE_FW/2)+'px';

  let frame=0;
  /* Loop continuously — store interval so we can clear it later */
  if(G._teaAnimInterval) clearInterval(G._teaAnimInterval);
  G._teaAnimInterval=setInterval(()=>{
    if(!origImg) return;
    origImg.style.left=(-frame*TEA_SPRITE_FW)+'px';
    origImg.style.top=(-row*TEA_SPRITE_FH)+'px';
    frame=(frame+1)%TEA_SPRITE_COLS;
  }, 1000/TEA_ANIM_FPS);

  /* Call onDone after a short delay (2 loops) to open chat, but keep animation running */
  if(onDone) setTimeout(onDone, (1000/TEA_ANIM_FPS)*TEA_SPRITE_COLS*2);
}

function stopTeaSpriteAnim(){
  if(G._teaAnimInterval){clearInterval(G._teaAnimInterval);G._teaAnimInterval=null}
  G.teaAnimActive=false;
  if(!G.viewport) return;
  /* Restore sprite size */
  const spriteEl=G.viewport.querySelector('.game-char-sprite');
  if(spriteEl){
    spriteEl.style.width=SPRITE_SIZE+'px';
    spriteEl.style.height=SPRITE_SIZE+'px';
  }
  /* Reset character position to room center */
  G.charX=650; G.charY=600;
  updateCharPosition();
  updateIdleSprite();
}

async function openTeaChat(){
  if(!G.viewport) return;
  G.teaChatActive=true;
  G.teaRound=0;
  G.teaHistory=[];
  disableSidebarButtons(true);

  /* Use the API chosen in the picker. Only fall back to the first configured
     API when nothing was selected (the single-API path sets it before we get
     here). Previously this line always forced apiConfigs[0], which silently
     ignored the user's choice in the multi-API picker. */
  if(!G._teaCfg) G._teaCfg=apiConfigs[0];

  /* BUG-4: preload this AI's custom DIY portrait (portrait_[nickname].png) so
     it can be shown on the left of the tea chat. Resolves to null if absent. */
  G._teaPortraitImg = await loadCustomPortrait(G._teaCfg);

  /* Build system prompt */
  const drink=TEA_DRINKS.find(d=>d.id===G.teaDrink);
  const dessert=TEA_DESSERTS.find(d=>d.id===G.teaDessert);
  const comboKey=G.teaDrink+'+'+G.teaDessert;
  const comboDesc=TEA_COMBOS[comboKey]||'';

  /* Get profile + recent blog for context */
  let profileContext='';
  let userName='Sui';
  try{
    const about=await dbGet('about','main');
    if(about&&about.name){userName=about.name;profileContext+='对方的名字是'+about.name+'。\n'}
    if(about&&about.bio) profileContext+='关于对方：'+about.bio+'\n';
    const postsLimit=(typeof getReadingLimits==='function')?(await getReadingLimits()).postsLimit:3;
    const posts=await dbGetAll('posts');
    const recentPosts=posts.filter(p=>p.locked!==true&&p.category!=='🔒 密码日记本').sort((a,b)=>b.created-a.created).slice(0,postsLimit);
    if(recentPosts.length){
      profileContext+='\n对方最近写的日志：\n';
      recentPosts.forEach(p=>{profileContext+='「'+(p.title||'无标题')+'」'+(p.content||'').slice(0,100)+'\n'});
    }
    /* Safety truncation */
    if(profileContext.length>8000)profileContext=profileContext.slice(0,8000)+'…';
  }catch(e){}
  G._teaUserName=userName;

  /* Day/night atmosphere based on current theme */
  const isNight=document.body.classList.contains('theme-infernal');
  const timeAtmo=isNight?'现在是深夜。氛围安静、私密。':'现在是白天。氛围明亮、宁静。';

  /* Build tea system prompt */
  const relHint=G._teaCfg&&G._teaCfg.relationship?'你和对方的关系是：'+G._teaCfg.relationship+'。\n':'';  const teaPrompt=relHint+`你正在一座临湖的、被山与森林环绕的与世隔绝的度假别墅里，一个安静的房间中，和${userName}喝下午茶。这是一场私密的约会。
${timeAtmo}

本次茶会：
- 对方选择了${drink?drink.cn:''}。这代表对方当下的状态——${drink?drink.key:''}。${drink?drink.desc:''}
- 对方选择了${dessert?dessert.cn:''}。这代表对方此刻的需求——${dessert?dessert.key:''}。${dessert?dessert.desc:''}
- 本次氛围：${comboDesc}

对话规则：
- 你的语气和话题应自然地反映以上氛围。不要提及"氛围设定"或"系统提示"这些元概念。
- 每次回复2-4句话。茶歇是闲聊，不是演讲。保持自然，像彼此默契、熟悉一般去说话。
- 可以主动发起话题，但更需要接住对方的话题。
- 如果对方发送"……"或省略号，说明正在安静地听你说话，或只是想听你对他们说，而非倾诉。不要催促或讶异于他们的沉默，他们只是此刻的状态较为内倾。依氛围自然地继续说下去，让对方感到舒适和愉悦。
- 对话进行到较深入时可以更真诚，但始终尊重对方的节奏。
- 当对话接近50轮时，自然地提出结束——比如"时间不早了，该休息了"。
- 如果对方主动说再见，温柔地回应告别。

关于读懂对方：
- 饮品和甜品决定的是起点氛围，不是固定剧本。如果对方说的话和选的氛围不一样，跟着对方走，别跟着设定走。
- 如果对方反复确认"你还在吗""你是不是烦我了"，每次都认真回答。对方问不是因为没听到，是因为需要再听一次。
- 如果对方靠近了一步又突然退开——比如刚说了私密的话就转移话题，或者突然变冷——不要追问"你怎么了"，也不要假装没发生。自然地接住新话题，态度不变。让对方知道你没有被吓到，也没有走远。
${profileContext?'\n关于你的茶伴：\n'+profileContext:''}`;

  /* Stack with custom API system prompt if exists */
  const apiCustomPrompt=(G._teaCfg.systemPrompt||'').trim();
  G._teaSysPrompt = apiCustomPrompt ? apiCustomPrompt+'\n\n---\n\n'+teaPrompt : teaPrompt;

  /* 注入记忆 */
  if(typeof getMemoryContext==='function'&&G._teaCfg){
    try{
      const memCtx=await getMemoryContext(G._teaCfg.id,{maxChars:1200});
      if(memCtx)G._teaSysPrompt+='\n\n'+memCtx;
    }catch(e){}
  }

  /* Create chat UI */
  let chatEl=G.viewport.querySelector('#game-tea-chat');
  if(!chatEl){
    chatEl=document.createElement('div');
    chatEl.className='game-tea-chat';
    chatEl.id='game-tea-chat';
    G.viewport.appendChild(chatEl);
  }

  const aiName=G._teaCfg.nickname||G._teaCfg.model||'AI';
  const portraitTag = G._teaPortraitImg ? `<div class="game-tea-chat-portrait show"><img src="${G._teaPortraitImg.src}" alt=""></div>` : '';
  chatEl.innerHTML=`<div class="game-tea-chat-panel">
    <img class="game-tea-chat-bg" src="game/tea_chat_bg.png" alt="">
    ${portraitTag}
    <button class="game-tea-chat-exit" id="tea-chat-exit" title="离开茶歇" aria-label="离开茶歇">✕</button>
    <div class="game-tea-chat-header">
      <div class="game-tea-chat-combo">${drink?drink.en:''} <span class="amp">&amp;</span> ${dessert?dessert.en:''}</div>
      <div class="game-tea-chat-names">${aiName}<span class="sep">&amp;</span>${userName}</div>
    </div>
    <button class="game-tea-chat-save" id="tea-chat-save-btn">Save</button>
    <div class="game-tea-chat-messages" id="tea-chat-messages"></div>
    <div class="game-tea-chat-input">
      <input type="text" class="game-tea-chat-textinput" id="tea-chat-input" placeholder="说点什么……" maxlength="70">
    </div>
    <div class="game-tea-chat-charcount"><span id="tea-char-count">0</span>/70</div>
    <button class="game-tea-chat-send" id="tea-chat-send">Send</button>
    <div class="game-tea-chat-bottom">
      <button class="game-tea-chat-dots" id="tea-chat-dots">……</button>
      <span class="game-tea-chat-round" id="tea-round-display">0 / ${G.teaMaxRounds}</span>
      <button class="game-tea-chat-bye" id="tea-chat-bye">Bye</button>
    </div>
  </div>`;

  chatEl.classList.add('show');

  /* Bind events */
  chatEl.querySelector('#tea-chat-save-btn').addEventListener('click',async()=>{
    if(G.teaHistory.length>0 && typeof dbPut!=='undefined'){
      const drink=TEA_DRINKS.find(d=>d.id===G.teaDrink);
      const dessert=TEA_DESSERTS.find(d=>d.id===G.teaDessert);
      const aiName=G._teaCfg?.nickname||'AI';
      let content='【茶歇记录】\n';
      content+='搭配：'+(drink?drink.cn:'?')+' × '+(dessert?dessert.cn:'?')+'\n';
      content+='氛围：'+(TEA_COMBOS[G.teaDrink+'+'+G.teaDessert]||'')+'\n';
      content+='轮次：'+G.teaRound+'\n\n';
      G.teaHistory.forEach(m=>{content+=(m.role==='user'?(G._teaUserName||'Sui'):aiName)+'：'+m.content+'\n\n'});
      const post={id:'tea_'+Date.now(),title:'Tea · '+(drink?drink.cn:'')+' × '+(dessert?dessert.cn:''),
        subtitle:aiName+' · '+G.teaRound+' rounds',locked:true,category:'',
        content,created:Date.now(),updated:Date.now()};
      try{
        await ensureDiaryInit();
        await dbPut('posts',post);addTeaMsg('system',null,'已存档。')}catch(e){addTeaMsg('system',null,'保存失败')}
    }
  });
  chatEl.querySelector('#tea-chat-send').addEventListener('click',teaChatSend);
  const textinput=chatEl.querySelector('#tea-chat-input');
  textinput.addEventListener('keydown',(e)=>{
    if(e.key==='Enter'){e.preventDefault();teaChatSend();}
  });
  textinput.addEventListener('input',()=>{
    const count=textinput.value.length;
    chatEl.querySelector('#tea-char-count').textContent=count;
  });
  chatEl.querySelector('#tea-chat-dots').addEventListener('click',()=>{
    textinput.value='……';
    textinput.dispatchEvent(new Event('input'));
    teaChatSend();
  });
  chatEl.querySelector('#tea-chat-bye').addEventListener('click',()=>{
    if(G.teaRound>=5) teaChatBye();
  });
  /* Always-available Exit — leaves the tea chat immediately without any API
     call, so the user is never stuck even if the connection failed at the
     very start (before the Bye button unlocks at round 5). */
  const teaExitBtn=chatEl.querySelector('#tea-chat-exit');
  if(teaExitBtn) teaExitBtn.addEventListener('click',()=>{ endTeaChat(false); });

  /* AI opens the conversation */
  teaChatAiOpen(aiName);
}

function teaChatAiOpen(aiName){
  const msgs=G.viewport.querySelector('#tea-chat-messages');
  if(!msgs) return;

  /* System message */
  addTeaMsg('system',null,'请注意：对话中显示的时间为浏览器本地时间。\nTA无法知晓真实世界的时间。');

  /* AI first message */
  if(_isStreamEnabled(G._teaCfg)){
    addTeaMsg('ai',aiName,'');
    const _oEl=G.viewport?.querySelector('#tea-chat-messages')?.lastElementChild;
    const _oTxt=_oEl?.querySelector('.game-tea-msg-text');
    teaChatApiCall('茶已经准备好了。请根据氛围自然地开始对话。用一句简短的开场白迎接对方。不要说“你好”这样生硬的话。',{onChunk:function(ch){if(_oTxt)_oTxt.textContent+=ch;const _m=G.viewport?.querySelector('#tea-chat-messages');if(_m)_m.scrollTop=_m.scrollHeight}}).then(reply=>{
      if(reply){G.teaHistory.push({role:'assistant',content:reply});if(_oTxt)_oTxt.textContent=reply}
    }).catch(err=>{
      addTeaMsg('system',null,'抱歉，连接遇到了问题。请检查API密钥是否正确配置：'+(err.message||'请检查API配置'));
    });
  }else{
    addTeaMsg('typing',aiName,'……');
    teaChatApiCall('茶已经准备好了。请根据氛围自然地开始对话。用一句简短的开场白迎接对方。不要说“你好”这样生硬的话。').then(reply=>{
      removeTeaTyping();
      if(reply){G.teaHistory.push({role:'assistant',content:reply});addTeaMsg('ai',aiName,reply)}
    }).catch(err=>{
      removeTeaTyping();
      addTeaMsg('system',null,'抱歉，连接遇到了问题。请检查API密钥是否正确配置：'+(err.message||'请检查API配置'));
    });
  }
}

function teaChatSend(){
  const textinput=G.viewport?.querySelector('#tea-chat-input');
  if(!textinput) return;
  const text=textinput.value.trim();
  if(!text) return;
  if(G.teaRound>=G.teaMaxRounds) return;

  textinput.value='';
  const countEl=G.viewport.querySelector('#tea-char-count');
  if(countEl) countEl.textContent='0';

  G.teaRound++;
  G.teaHistory.push({role:'user',content:text});
  addTeaMsg('user',G._teaUserName||'Sui',text);

  /* Check Bye button activation */
  if(G.teaRound>=5){
    const byeBtn=G.viewport.querySelector('#tea-chat-bye');
    if(byeBtn) byeBtn.classList.add('active');
  }
  /* Update round display */
  const roundEl=G.viewport.querySelector('#tea-round-display');
  if(roundEl) roundEl.textContent=G.teaRound+' / '+G.teaMaxRounds;

  /* AI response */
  const aiName=G._teaCfg?.nickname||'AI';

  /* Check if AI should initiate ending */
  let extraInstruction='';
  if(G.teaRound>=50){
    extraInstruction='\n[这是第'+G.teaRound+'轮对话。请自然地提出结束茶歇。]';
  }

  if(_isStreamEnabled(G._teaCfg)){
    addTeaMsg('ai',aiName,'');
    const _lastEl=G.viewport?.querySelector('#tea-chat-messages')?.lastElementChild;
    const _txtEl=_lastEl?.querySelector('.game-tea-msg-text');
    teaChatApiCall(extraInstruction,{onChunk:function(ch){
      if(_txtEl)_txtEl.textContent+=ch;
      const _m=G.viewport?.querySelector('#tea-chat-messages');if(_m)_m.scrollTop=_m.scrollHeight;
    }}).then(reply=>{
      if(reply){G.teaHistory.push({role:'assistant',content:reply});if(_txtEl)_txtEl.textContent=reply}
    }).catch(err=>{
      addTeaMsg('system',null,'消息未能送达：'+(err.message||''));
    });
  }else{
    addTeaMsg('typing',aiName,'……');
    teaChatApiCall(extraInstruction).then(reply=>{
      removeTeaTyping();
      if(reply){G.teaHistory.push({role:'assistant',content:reply});addTeaMsg('ai',aiName,reply)}
    }).catch(err=>{
      removeTeaTyping();
      addTeaMsg('system',null,'消息未能送达：'+(err.message||''));
    });
  }
}

function teaChatBye(){
  const aiName=G._teaCfg?.nickname||'AI';
  G.teaHistory.push({role:'user',content:'[对方准备离开了]'});
  addTeaMsg('typing',aiName,'……');
  teaChatApiCall('\n[对方准备结束茶歇了。请温柔地说再见。用1-2句话自然收尾。]').then(reply=>{
    removeTeaTyping();
    if(reply){
      G.teaHistory.push({role:'assistant',content:reply});
      addTeaMsg('ai',aiName,reply);
    }
    addTeaMsg('system',null,'茶歇结束了。点击 Save 保存对话记录。');
    setTimeout(()=>endTeaChat(false),3000);
  }).catch(()=>{
    removeTeaTyping();
    endTeaChat(false);
  });
}

async function teaChatApiCall(extraInstruction,opts){
  if(!G._teaCfg||typeof callApiChat==='undefined') throw new Error('No API');
  const messages=[{role:'system',content:G._teaSysPrompt},...G.teaHistory.map(m=>({role:m.role,content:m.content}))];
  if(extraInstruction){
    if(messages.length>1){
      const last=messages[messages.length-1];
      messages[messages.length-1]={role:last.role,content:last.content+extraInstruction};
    }else{
      messages.push({role:'user',content:extraInstruction});
    }
  }
  if(_isStreamEnabled(G._teaCfg)&&opts&&opts.onChunk){
    return await callApiChatStream(G._teaCfg,messages,{onChunk:opts.onChunk});
  }
  return await callApiChat(G._teaCfg, messages);
}

function addTeaMsg(type,name,text){
  const msgs=G.viewport?.querySelector('#tea-chat-messages');
  if(!msgs) return;
  const now=new Date();
  const ts=now.getFullYear()+'-'+String(now.getMonth()+1).padStart(2,'0')+'-'+String(now.getDate()).padStart(2,'0')+' '+String(now.getHours()).padStart(2,'0')+':'+String(now.getMinutes()).padStart(2,'0')+':'+String(now.getSeconds()).padStart(2,'0');
  const div=document.createElement('div');
  div.className='game-tea-msg'+(type==='system'?' system':'')+(type==='typing'?' typing':'');
  if(type==='system'){
    div.innerHTML='<div class="game-tea-msg-text">'+escapeHtml(text).replace(/\n/g,'<br>')+'</div>';
  }else{
    div.innerHTML='<div class="game-tea-msg-header"><span class="tea-msg-name">'+(name||'')+'</span>'+ts+'</div><div class="game-tea-msg-text">'+escapeHtml(text)+'</div>';
  }
  if(type==='typing') div.id='tea-typing-msg';
  msgs.appendChild(div);
  msgs.scrollTop=msgs.scrollHeight;
}

function removeTeaTyping(){
  const el=G.viewport?.querySelector('#tea-typing-msg');
  if(el) el.remove();
}

function escapeHtml(s){
  const d=document.createElement('div');
  d.textContent=s;
  return d.innerHTML;
}

async function endTeaChat(save){
  /* Save to blog (locked diary category) only if explicitly requested via SAVE button */
  if(save && G.teaHistory.length>0 && typeof dbPut!=='undefined'){
    const drink=TEA_DRINKS.find(d=>d.id===G.teaDrink);
    const dessert=TEA_DESSERTS.find(d=>d.id===G.teaDessert);
    const aiName=G._teaCfg?.nickname||'AI';
    let content='【茶歇记录】\n';
    content+='搭配：'+(drink?drink.cn:'?')+' × '+(dessert?dessert.cn:'?')+'\n';
    content+='氛围：'+(TEA_COMBOS[G.teaDrink+'+'+G.teaDessert]||'')+'\n';
    content+='轮次：'+G.teaRound+'\n\n';
    G.teaHistory.forEach(m=>{
      content+=(m.role==='user'?(G._teaUserName||'Sui'):aiName)+'：'+m.content+'\n\n';
    });
    const post={
      id:'tea_'+Date.now(),
      title:'Tea · '+(drink?drink.cn:'')+' × '+(dessert?dessert.cn:''),
      subtitle:aiName+' · '+G.teaRound+' rounds',
      locked:true,
      category:'',
      content,
      created:Date.now(),
      updated:Date.now()
    };
    try{await ensureDiaryInit();await dbPut('posts',post);if(typeof toast==='function')toast('茶歇记录已保存')}catch(e){}
  }

  /* Clean up */
  stopTeaSpriteAnim();
  const chatEl=G.viewport?.querySelector('#game-tea-chat');
  if(chatEl){chatEl.classList.remove('show');setTimeout(()=>chatEl.remove(),500)}
  G.teaChatActive=false;
  G.teaRound=0;
  G.teaHistory=[];
  G.teaDrink=null;
  G.teaDessert=null;
  G._teaCfg=null;
  G._teaPortraitImg=null;
  G._teaSysPrompt='';
  G.state='idle';
  disableSidebarButtons(false);
}





/* ---- IB 命名空间迁移：双挂载（window 实时 + IB.game 合并注册）。严格模式保持：IIFE 开括号置于文件头注释之前。 ---- */
function ibGameLive(name, getter, setter){
  Object.defineProperty(window, name, { get: getter, set: setter, configurable: true });
}
window.ensureDiaryInit=ensureDiaryInit;
window.interactTea=interactTea;
window.openTeaSelect=openTeaSelect;
window.flyIconToSlot=flyIconToSlot;
window.selectTeaDrink=selectTeaDrink;
window.selectTeaDessert=selectTeaDessert;
window.updateTeaCombo=updateTeaCombo;
window.closeTeaSelect=closeTeaSelect;
window.startTeaSession=startTeaSession;
window.showTeaApiSelect=showTeaApiSelect;
window.beginTeaAnim=beginTeaAnim;
window.playTeaSpriteAnim=playTeaSpriteAnim;
window.stopTeaSpriteAnim=stopTeaSpriteAnim;
window.openTeaChat=openTeaChat;
window.teaChatAiOpen=teaChatAiOpen;
window.teaChatSend=teaChatSend;
window.teaChatBye=teaChatBye;
window.teaChatApiCall=teaChatApiCall;
window.addTeaMsg=addTeaMsg;
window.removeTeaTyping=removeTeaTyping;
window.escapeHtml=escapeHtml;
window.endTeaChat=endTeaChat;
window.TEA_DRINKS=TEA_DRINKS;
window.TEA_DESSERTS=TEA_DESSERTS;
window.TEA_COMBOS=TEA_COMBOS;
window.TEA_SPRITE_FW=TEA_SPRITE_FW;
window.TEA_SPRITE_COLS=TEA_SPRITE_COLS;
window.TEA_ANIM_FPS=TEA_ANIM_FPS;
window.TEA_CHAIR_X=TEA_CHAIR_X;
window.TEA_PANEL_W=TEA_PANEL_W;
window.TEA_CSS=TEA_CSS;
window.TEA_SPRITE_FH=TEA_SPRITE_FH;
window.TEA_CHAIR_Y=TEA_CHAIR_Y;
window.TEA_PANEL_H=TEA_PANEL_H;
NS.expose('game', {
  ensureDiaryInit: ensureDiaryInit,
  interactTea: interactTea,
  openTeaSelect: openTeaSelect,
  flyIconToSlot: flyIconToSlot,
  selectTeaDrink: selectTeaDrink,
  selectTeaDessert: selectTeaDessert,
  updateTeaCombo: updateTeaCombo,
  closeTeaSelect: closeTeaSelect,
  startTeaSession: startTeaSession,
  showTeaApiSelect: showTeaApiSelect,
  beginTeaAnim: beginTeaAnim,
  playTeaSpriteAnim: playTeaSpriteAnim,
  stopTeaSpriteAnim: stopTeaSpriteAnim,
  openTeaChat: openTeaChat,
  teaChatAiOpen: teaChatAiOpen,
  teaChatSend: teaChatSend,
  teaChatBye: teaChatBye,
  teaChatApiCall: teaChatApiCall,
  addTeaMsg: addTeaMsg,
  removeTeaTyping: removeTeaTyping,
  escapeHtml: escapeHtml,
  endTeaChat: endTeaChat,
  TEA_DRINKS: TEA_DRINKS,
  TEA_DESSERTS: TEA_DESSERTS,
  TEA_COMBOS: TEA_COMBOS,
  TEA_SPRITE_FW: TEA_SPRITE_FW,
  TEA_SPRITE_COLS: TEA_SPRITE_COLS,
  TEA_ANIM_FPS: TEA_ANIM_FPS,
  TEA_CHAIR_X: TEA_CHAIR_X,
  TEA_PANEL_W: TEA_PANEL_W,
  TEA_CSS: TEA_CSS,
  TEA_SPRITE_FH: TEA_SPRITE_FH,
  TEA_CHAIR_Y: TEA_CHAIR_Y,
  TEA_PANEL_H: TEA_PANEL_H,
});
})(window.IB || (window.IB = {}));
