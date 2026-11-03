'use strict';
/**
 * MC Bot Launcher - lõi chương trình
 * Chạy: node server.js  -> mở http://localhost:3000
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { WebSocketServer } = require('ws');
const mineflayer = require('mineflayer');
let nbt = null;
try { nbt = require('prismarine-nbt'); } catch { /* không bắt buộc */ }
const { planDialog } = require('./dialog');
const { Pvp } = require('./pvp');
const { Mover } = require('./mover');

const HTTP_PORT = Number(process.env.PORT) || 3000;
// Render/Docker/VPS đặt PORT hoặc HOST -> lắng nghe mọi địa chỉ; chạy cục bộ -> chỉ 127.0.0.1
const HOST = process.env.HOST || ((process.env.PORT || process.env.RENDER) ? '0.0.0.0' : '127.0.0.1');
const IS_LOCAL = HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1';
const APP_PASSWORD = process.env.APP_PASSWORD || '';
// Thư mục lưu dữ liệu (profiles.json, auth-cache). Trên Render hãy trỏ tới Persistent Disk, vd /var/data
const DATA_DIR = process.env.DATA_DIR || __dirname;
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch { /* bỏ qua */ }
const PROFILE_FILE = path.join(DATA_DIR, 'profiles.json');
const AUTH_CACHE = path.join(DATA_DIR, 'auth-cache');

if (!IS_LOCAL && !APP_PASSWORD) {
  console.error('LỖI: server đang mở ra Internet (HOST=' + HOST + ') nhưng chưa đặt biến môi trường APP_PASSWORD.');
  console.error('Nếu không có mật khẩu, bất kỳ ai cũng điều khiển được bot và đọc được mật khẩu AuthMe của bạn.');
  process.exit(1);
}
const MAX_LOG = 600;

const DEFAULTS = {
  name: '', host: '', port: '', version: '', auth: 'offline', password: '',
  autoAuth: true,            // tự /register + /login (AuthMe)
  autoReconnect: true,       // tự vào lại khi bị rớt
  reconnectDelay: 10,        // giây
  antiAfk: true,             // giả lập hoạt động nhẹ để không bị kick AFK
  afkInterval: 30,           // giây
  autoAttack: false,         // tự đánh mob gần nhất / vung tay
  autoUse: false,            // tự chuột phải (dùng vật phẩm đang cầm)
  clickInterval: 1000,       // ms
  autoStart: false,          // tự kết nối khi server (Render/VPS) khởi động lại
  acceptResourcePack: true,  // true = chấp nhận resource pack của server | false = từ chối
  viewDistance: 4,           // tầm nhìn chunk: càng nhỏ càng tiết kiệm RAM (mặc định mineflayer là 12!)
  // --- PvP: 1. Chung ---
  pvpEnabled: false,         // đánh người chơi gần đó
  pvpMode: 'all',            // all = mọi người chơi | retaliate = chỉ người vừa đánh mình
  pvpRange: 16,              // tầm phát hiện (block)
  pvpReach: 3,               // tầm đánh (block)
  pvpIgnore: '',             // tên bỏ qua, cách nhau bằng dấu phẩy
  pvpStrafe: true,           // di chuyển ngang né đòn
  // --- 2. Kiếm / Rìu ---
  pvpWeapon: 'auto',         // auto | sword | axe
  pvpCrit: true,             // nhảy rồi đánh khi đang rơi (chí mạng)
  pvpShieldBreak: true,      // đổi sang rìu khi đối thủ cầm khiên
  // --- 3. End Crystal ---
  crystalEnabled: false,
  crystalObsidian: false,    // tự đặt obsidian làm đế nếu chưa có
  crystalMaxSelf: 12,        // sát thương tự gánh tối đa (ước lượng thô, tính bằng máu)
  crystalMinHp: 10,          // máu tối thiểu để đặt crystal
  // --- 4. Auto Totem ---
  totemEnabled: false,
  // --- 5. Ăn & Giáp ---
  eatEnabled: false, eatFood: 14,
  gapEnabled: false, gapHp: 10,
  armorEnabled: false,
  // --- 6. An toàn ---
  retreatHp: 0,              // 0 = tắt; máu <= số này thì chạy lui
  logoutHp: 0,               // 0 = tắt; máu <= số này thì tự thoát server
  // --- Di chuyển ---
  kbRespect: true,           // tạm nhả phím di chuyển do bot tự đặt sau khi bị knockback/nổ
  kbHold: 350,               // thời gian nhả (ms)
  kbLog: false,              // ghi log mỗi lần nhận knockback (để kiểm tra server có gửi không)
  autoJump: true,            // tự nhảy lên bậc cao 1 block
  stuckEnabled: true,        // tự thoát khi bị kẹt
  stuckAfter: 1.5,           // kẹt liên tục bao nhiêu giây thì bắt đầu thoát
  stuckPlace: true,          // nhảy + đặt block dưới chân
  stuckPearl: true,          // ném ender pearl qua kẽ hở
  stuckDig: true,            // cầm cúp đào 2 block phía trước
  respawnCommands: '',       // lệnh chạy ngay sau khi hồi sinh, mỗi dòng 1 lệnh
  respawnDelay: 2,           // giây chờ sau khi hồi sinh
  joinCommands: '',          // lệnh chạy sau khi vào server, mỗi dòng 1 lệnh
  joinDelay: 6               // giây chờ sau khi spawn
};

const sessions = new Map();
const clients = new Set();
let nextId = 1;

function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const c of clients) if (c.readyState === 1) c.send(s);
}

/* ---------- tiện ích đọc lý do bị kick ---------- */
function flat(o) {
  if (o == null) return '';
  if (typeof o === 'string') return o;
  if (typeof o === 'number' || typeof o === 'boolean') return String(o);
  if (Array.isArray(o)) return o.map(flat).join('');
  let s = flat(o.text);
  if (o.translate) {
    s += (s ? ' ' : '') + o.translate;
    if (Array.isArray(o.with)) s += ' ' + o.with.map(flat).join(' ');
  }
  if (o.extra) s += flat(o.extra);
  return s;
}
function reasonText(r) {
  try {
    let o = r;
    if (typeof o === 'string') {
      try { o = JSON.parse(o); } catch { return o.replace(/§./g, ''); }
    }
    if (nbt && o && o.type && o.value !== undefined) o = nbt.simplify(o);
    return (flat(o) || JSON.stringify(o)).replace(/§./g, '');
  } catch { return String(r); }
}

function sanitize(input) {
  const out = {};
  for (const k of Object.keys(DEFAULTS)) {
    if (!(k in input)) continue;
    const d = DEFAULTS[k], v = input[k];
    if (typeof d === 'boolean') out[k] = !!v;
    else if (typeof d === 'number') out[k] = Number.isFinite(Number(v)) && v !== '' ? Number(v) : d;
    else if (k === 'password' || k === 'joinCommands' || k === 'respawnCommands') out[k] = String(v ?? '');
    else out[k] = String(v ?? '').trim();
  }
  if ('pvpMode' in out && !['all', 'retaliate'].includes(out.pvpMode)) out.pvpMode = 'all';
  if ('pvpWeapon' in out && !['auto', 'sword', 'axe'].includes(out.pvpWeapon)) out.pvpWeapon = 'auto';
  if ('viewDistance' in out) out.viewDistance = Math.max(2, Math.min(12, Math.round(out.viewDistance) || 4));
  return out;
}

/* ---------- gửi custom_click_action đúng định dạng của Minecraft thật ----------
 * Theo minecraft.wiki (Java Edition protocol), gói serverbound custom_click_action gồm:
 *   ID (Identifier) | Payload size (VarInt) | Payload (NBT, định dạng mạng không tên)
 * minecraft-data lại mô tả sai (option<NBT>), nên ta tự ghép gói tin thô: lấy phần đầu
 * (packet id + chuỗi id) do thư viện tạo, rồi thêm độ dài + NBT. Không có payload = 1 byte 0x00 (TAG_End). */
function varint(n) {
  const out = [];
  do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n);
  return Buffer.from(out);
}
function writeClickAction(client, id, tag) {
  const buf = client.serializer.createPacketBuffer({ name: 'custom_click_action', params: { id, nbt: tag || undefined } });
  const idLen = Buffer.byteLength(id);
  const pidLen = (buf[0] & 0x80) ? 2 : 1;                     // độ dài varint của packet id
  const off = pidLen + (idLen < 128 ? 1 : 2) + idLen;         // vị trí ngay sau chuỗi id
  if (buf[off] !== (tag ? 0x01 : 0x00)) throw new Error('định dạng gói tin không như dự kiến, huỷ gửi');
  const head = buf.subarray(0, off);
  const body = tag ? buf.subarray(off + 1) : Buffer.from([0x00]); // bỏ byte boolean của thư viện
  client.writeRaw(Buffer.concat([head, varint(body.length), body]));
}

/* ---------- 1 phiên bot ---------- */
class Session {
  constructor(id, cfg) {
    this.id = id;
    this.cfg = { ...DEFAULTS, ...sanitize(cfg || {}) };
    this.bot = null;
    this.pvp = null;
    this.mover = null;
    this.deadPending = false;
    this.state = 'offline'; // offline | connecting | online
    this.logs = [];
    this.timers = new Set();
    this.reconnectTimer = null;
    this.attempts = 0;
    this.manualStop = false;
    this.noRetry = false;
  }

  log(kind, text) {
    const entry = { t: Date.now(), kind, text: String(text) };
    this.logs.push(entry);
    if (this.logs.length > MAX_LOG) this.logs.shift();
    broadcast({ type: 'log', id: this.id, entry });
  }

  setState(st) { this.state = st; broadcast({ type: 'summary', bot: this.summary() }); }
  summary() { return { id: this.id, cfg: this.cfg, state: this.state, info: this.info() }; }

  info() {
    const b = this.bot;
    if (this.state !== 'online' || !b || !b.entity) return null;
    const p = b.entity.position;
    return {
      pos: [p.x.toFixed(1), p.y.toFixed(1), p.z.toFixed(1)],
      health: b.health, food: b.food,
      dim: b.game && b.game.dimension,
      ping: b.player && b.player.ping,
      players: Object.keys(b.players || {}).length,
      held: b.heldItem ? b.heldItem.displayName || b.heldItem.name : 'Tay không',
      target: this.pvp ? this.pvp.status() : null,
      version: b.version
    };
  }

  later(fn, ms) {
    const t = setTimeout(() => { this.timers.delete(t); try { fn(); } catch (e) { this.log('err', e.message); } }, ms);
    this.timers.add(t);
    return t;
  }
  clearTimers() {
    for (const t of this.timers) { clearTimeout(t); clearInterval(t); }
    this.timers.clear();
  }

  /* ----- kết nối ----- */
  connect() {
    if (this.bot) return;
    clearTimeout(this.reconnectTimer);
    const c = this.cfg;
    if (!c.name || !c.host) { this.log('err', 'Thiếu tên bot hoặc IP server.'); return; }
    this.manualStop = false;
    this.noRetry = false;
    this.authAttempts = 0;
    this.authSeen = false;
    this.lastAuth = 0;
    this.dialogCount = 0;
    this.spawned = false;
    this.packDeclined = false;
    this.setState('connecting');
    const port = Number(c.port) || 25565;
    this.log('sys', `Đang kết nối ${c.host}:${port} | phiên bản: ${c.version || 'tự nhận diện'} | tên: ${c.name}`);

    const opts = {
      host: c.host, port, username: c.name, auth: c.auth || 'offline',
      checkTimeoutInterval: 90 * 1000, // chịu lag server tới 90s mới coi là timeout
      connectTimeout: 30 * 1000,
      hideErrors: true,
      viewDistance: Math.max(2, Number(c.viewDistance) || 4),
      maxCatchupTicks: 8   // bù tick vật lý khi máy yếu/lag, giúp knockback và rơi không bị "nuốt"
    };
    if (c.version) opts.version = c.version;
    // Từ chối resource pack: tắt plugin nội bộ của mineflayer (nó tự chấp nhận ở giai đoạn configuration,
    // và hàm denyResourcePack của nó gửi thừa một gói thiếu uuid) rồi tự trả lời DECLINED ở bindResourcePack()
    if (!c.acceptResourcePack) opts.plugins = { resource_pack: false };
    if (c.auth === 'microsoft') {
      opts.profilesFolder = AUTH_CACHE;
      opts.onMsaCode = (d) => this.log('sys', `ĐĂNG NHẬP MICROSOFT: mở ${d.verification_uri} và nhập mã ${d.user_code}`);
    }

    let bot;
    try { bot = mineflayer.createBot(opts); }
    catch (e) { this.log('err', 'Không tạo được bot: ' + e.message); this.afterEnd(e.message); return; }
    this.bot = bot;
    this.bindEvents(bot);
    this.bindDialog(bot);
    this.bindResourcePack(bot);
    this.pvp = new Pvp(this, bot);
    this.mover = new Mover(this, bot);
  }

  /* ----- Hộp thoại (Dialog) của AuthMe 6.x trên 1.21.6+ ----- */
  bindDialog(bot) {
    const alive = () => this.bot === bot;
    bot._client.on('show_dialog', (pkt) => {
      if (!alive()) return;
      try {
        let raw = pkt.dialog;
        if (raw && raw.data) raw = raw.data; // giai đoạn play: hộp thoại nhúng trực tiếp
        if (!raw || raw.type !== 'compound') {
          this.log('warn', 'Server mở hộp thoại dạng tham chiếu (registry), bot chưa đọc được.');
          return;
        }
        const d = nbt.simplify(raw);
        this.log('sys', 'Server mở hộp thoại: ' + JSON.stringify(d).slice(0, 1500));
        if (!this.cfg.autoAuth || !this.cfg.password) {
          this.log('err', 'Hộp thoại yêu cầu mật khẩu nhưng chưa bật tự đăng nhập hoặc chưa nhập mật khẩu AuthMe.');
          return;
        }
        if (++this.dialogCount > 3) {
          this.log('err', 'Hộp thoại hiện lại quá 3 lần, dừng tự trả lời (mật khẩu có thể sai hoặc chưa đăng ký).');
          return;
        }
        const plan = planDialog(d, this.cfg.password);
        if (plan.type === 'none') { this.log('err', 'Không tự trả lời được hộp thoại: ' + plan.reason); return; }
        this.authSeen = true; // đã xử lý bằng hộp thoại, khỏi gửi /login dự phòng
        this.later(() => {
          if (!alive()) return;
          if (plan.type === 'packet') {
            writeClickAction(bot._client, plan.id, plan.nbt);
          } else if (bot._client.state === 'play') {
            bot.chat('/' + plan.command);
          } else {
            this.log('err', 'Hộp thoại cần chạy lệnh nhưng bot chưa vào thế giới.');
            return;
          }
          this.log('cmd', '[Tự động] Hộp thoại: ' + plan.desc);
        }, 400);
      } catch (e) { this.log('err', 'Lỗi xử lý hộp thoại: ' + e.message); }
    });
    bot._client.on('clear_dialog', () => alive() && this.log('sys', 'Server đóng hộp thoại.'));
  }

  /* ----- Resource pack của server: chấp nhận hoặc từ chối theo cấu hình ----- */
  bindResourcePack(bot) {
    const alive = () => this.bot === bot;
    const client = bot._client;
    if (this.cfg.acceptResourcePack) {
      // plugin nội bộ của mineflayer lo việc trả lời ACCEPTED + SUCCESSFULLY_LOADED (bot không thật sự tải gói về)
      bot.on('resourcePack', () => {
        if (!alive()) return;
        this.log('sys', 'Server gửi resource pack -> chấp nhận.');
        if (client.state === 'play') this.later(() => { try { bot.acceptResourcePack(); } catch { /* bỏ qua */ } }, 0); // hoãn 1 nhịp để plugin kịp lưu uuid/hash
      });
      return;
    }
    const DECLINED = 1;
    const decline = (data, withUuid) => {
      if (!alive()) return;
      this.packDeclined = true;
      this.log('sys', 'Server gửi resource pack -> từ chối (đã tắt \"chấp nhận resource pack\").');
      try {
        const pkt = { result: DECLINED };
        if (withUuid) pkt.uuid = data.uuid;
        else if (data.hash !== undefined && bot.supportFeature && bot.supportFeature('resourcePackUsesHash')) pkt.hash = data.hash;
        client.write('resource_pack_receive', pkt);
      } catch (e) { this.log('err', 'Không gửi được phản hồi từ chối resource pack: ' + e.message); }
    };
    // 1.20.3+: add_resource_pack (có uuid). Bản cũ hơn: resource_pack_send (có thể có uuid hoặc hash)
    client.on('add_resource_pack', (d) => decline(d, true));
    client.on('resource_pack_send', (d) => decline(d, !!(bot.supportFeature && bot.supportFeature('resourcePackUsesUUID'))));
  }

  bindEvents(bot) {
    const alive = () => this.bot === bot;

    bot.on('login', () => {
      if (!alive()) return;
      this.log('sys', `Đã vào giai đoạn login (giao thức ${bot.version}).`);
      // AuthMe có giới hạn thời gian đăng nhập: gửi /login ngay sau khi vào, không chờ spawn
      if (this.cfg.autoAuth && this.cfg.password) {
        this.later(() => {
          if (!this.authSeen) { this.log('sys', 'Gửi /login sớm để kịp thời gian chờ của AuthMe...'); this.sendAuth('login', true); }
        }, 1000);
      }
    });

    bot.on('spawn', () => {
      if (!alive()) return;
      this.setState('online');
      this.applyToggles();
      this.runRespawnCommands();   // vừa hồi sinh sau khi chết (chỉ chạy khi trước đó có 'death')
      if (this.spawned) return; // spawn lại do chết / đổi thế giới
      this.spawned = true;
      this.attempts = 0;
      this.log('sys', 'Bot đã xuất hiện trong thế giới.');
      // AuthMe: nếu server không gửi gợi ý trong chat (kiểu hộp thoại mới), thử /login sau 3.5s
      if (this.cfg.autoAuth && this.cfg.password) {
        this.later(() => {
          if (!this.authSeen) { this.log('sys', 'Không thấy gợi ý đăng nhập, thử /login...'); this.sendAuth('login', true); }
        }, 2500);
      }
      const lines = this.cfg.joinCommands.split('\n').map(s => s.trim()).filter(Boolean);
      lines.forEach((line, i) => {
        this.later(() => this.say(line, true), (this.cfg.joinDelay * 1000) + i * 1500);
      });
    });

    bot.on('messagestr', (msg, position) => {
      if (!alive() || position === 'game_info') return;
      const text = msg.replace(/§./g, '');
      if (!text.trim()) return;
      this.log('chat', text);
      this.checkAuthPrompt(text);
    });

    bot.on('death', () => { if (!alive()) return; this.deadPending = true; this.log('warn', 'Bot đã chết (tự hồi sinh).'); });
    // dự phòng: một số server gửi gói respawn nhưng không gửi lại máu nên 'spawn' không bắn
    bot.on('respawn', () => {
      if (!alive() || !this.deadPending) return;
      this.later(() => { if (alive()) this.runRespawnCommands(); }, 1500);
    });
    bot.on('kicked', (reason) => {
      if (!alive()) return;
      const t = reasonText(reason);
      this.log('err', 'Bị kick: ' + t);
      if (this.packDeclined && /resource|texture|pack/i.test(t)) {
        this.noRetry = true;
        this.log('warn', 'Có vẻ server BẮT BUỘC resource pack. Hãy bật \"Chấp nhận resource pack của server\" trong Sửa cấu hình rồi kết nối lại (đã tắt tự kết nối lại để khỏi lặp vô ích).');
      }
      if (/ban|cấm/i.test(t)) { this.noRetry = true; this.log('warn', 'Có vẻ bị ban -> tắt tự kết nối lại.'); }
    });
    bot.on('error', (err) => alive() && this.log('err', 'Lỗi: ' + (err && err.message || err)));
    bot.once('end', (reason) => {
      if (!alive()) return;
      this.afterEnd(reason);
    });
  }

  runRespawnCommands() {
    if (!this.deadPending) return;
    this.deadPending = false;
    const rl = String(this.cfg.respawnCommands || '').split('\n').map(s => s.trim()).filter(Boolean);
    if (!rl.length) return;
    const delay = Math.max(0, Number(this.cfg.respawnDelay) || 0);
    this.log('sys', `Vừa hồi sinh, sẽ chạy ${rl.length} lệnh sau ${delay}s.`);
    rl.forEach((line, i) => this.later(() => this.say(line, true), delay * 1000 + i * 1500));
  }

  afterEnd(reason) {
    if (this.pvp) { this.pvp.stop(); this.pvp = null; }
    if (this.mover) { this.mover.stop(); this.mover = null; }
    this.clearTimers();
    this.bot = null;
    this.log('sys', 'Mất kết nối: ' + (reason || 'không rõ lý do'));
    this.setState('offline');
    if (this.cfg.autoReconnect && !this.manualStop && !this.noRetry) {
      this.attempts++;
      const delay = Math.max(3, this.cfg.reconnectDelay) * (1 + Math.min(this.attempts - 1, 5)); // tăng dần, tối đa x6
      this.log('sys', `Tự kết nối lại sau ${delay}s (lần ${this.attempts})...`);
      this.reconnectTimer = setTimeout(() => this.connect(), delay * 1000);
    }
  }

  disconnect() {
    this.manualStop = true;
    clearTimeout(this.reconnectTimer);
    if (this.bot) { this.log('sys', 'Đang ngắt kết nối...'); try { this.bot.quit(); } catch { /* */ } }
    else if (this.state !== 'offline') this.setState('offline');
  }

  /* ----- AuthMe ----- */
  checkAuthPrompt(text) {
    if (!this.cfg.autoAuth || !this.cfg.password) return;
    if (/^<[^>]+>/.test(text)) return; // bỏ qua chat của người chơi
    const low = text.toLowerCase();
    let cmd = null;
    if (low.includes('/register') || low.includes('/reg ')) cmd = 'register';
    else if (low.includes('/login') || low.includes('/l ')) cmd = 'login';
    if (cmd) this.sendAuth(cmd);
  }
  sendAuth(cmd, fallback) {
    if (!this.bot) return;
    if (Date.now() - this.lastAuth < 1500 || this.authAttempts >= 4) return;
    this.lastAuth = Date.now();
    this.authAttempts++;
    if (!fallback) this.authSeen = true; // chỉ coi là "đã thấy gợi ý" khi do server nhắc thật
    const pw = this.cfg.password;
    this.bot.chat(cmd === 'register' ? `/register ${pw} ${pw}` : `/login ${pw}`);
    this.log('cmd', `[Tự động] /${cmd} ****`);
  }

  /* ----- hành vi định kỳ: anti-AFK, tự đánh, tự chuột phải ----- */
  applyToggles() {
    clearInterval(this.afkTimer);
    clearInterval(this.clickTimer);
    const b = this.bot;
    if (!b || this.state !== 'online') return;
    const c = this.cfg;
    if (c.antiAfk) {
      this.afkTimer = setInterval(() => {
        if (!this.bot || !this.bot.entity) return;
        try {
          const e = this.bot.entity;
          this.bot.look(e.yaw + (Math.random() - 0.5) * 1.2, (Math.random() - 0.5) * 0.6, false).catch(() => {});
          if (Math.random() < 0.5) {
            this.bot.setControlState('jump', true);
            setTimeout(() => this.bot && this.bot.setControlState('jump', false), 300);
          } else this.bot.swingArm('right');
        } catch { /* bỏ qua */ }
      }, Math.max(5, c.afkInterval) * 1000);
      this.timers.add(this.afkTimer);
    }
    if (c.autoAttack || c.autoUse) {
      this.clickTimer = setInterval(() => {
        const bot = this.bot;
        if (!bot || !bot.entity) return;
        try {
          if (c.autoAttack) {
            const target = bot.nearestEntity(e => (e.type === 'mob' || e.type === 'hostile') &&
              bot.entity.position.distanceTo(e.position) <= 3.5);
            if (target) bot.attack(target); else bot.swingArm('right');
          }
          if (c.autoUse) bot.activateItem();
        } catch { /* bỏ qua */ }
      }, Math.max(100, c.clickInterval));
      this.timers.add(this.clickTimer);
    }
  }

  update(partial) {
    Object.assign(this.cfg, sanitize(partial));
    broadcast({ type: 'summary', bot: this.summary() });
    if (this.state === 'online') this.applyToggles();
  }

  /* ----- điều khiển ----- */
  say(text, auto) {
    if (!this.bot || this.state !== 'online') { this.log('err', 'Bot chưa online, không gửi được.'); return; }
    text = String(text);
    if (!text.trim()) return;
    if (text.length > 256) { text = text.slice(0, 256); this.log('warn', 'Tin nhắn dài quá 256 ký tự, đã cắt bớt.'); }
    try { this.bot.chat(text); } catch (e) { this.log('err', e.message); return; }
    const hidden = /^\/(login|l|register|reg)\s/i.test(text) ? text.split(/\s/)[0] + ' ****' : text;
    this.log('cmd', (auto ? '[Tự động] ' : '> ') + hidden);
  }
  control(key, on) {
    const ok = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'];
    if (ok.includes(key) && this.bot && this.bot.entity) this.bot.setControlState(key, !!on);
  }
  turn(yawDeg, pitchDeg) {
    const b = this.bot;
    if (!b || !b.entity) return;
    const pitch = Math.max(-1.55, Math.min(1.55, b.entity.pitch + pitchDeg * Math.PI / 180));
    b.look(b.entity.yaw + yawDeg * Math.PI / 180, pitch, true).catch(() => {});
  }
  action(name, value) {
    const b = this.bot;
    if (!b || !b.entity) return;
    try {
      if (name === 'swing') b.swingArm('right');
      else if (name === 'attack') {
        const t = b.nearestEntity(e => e !== b.entity && b.entity.position.distanceTo(e.position) <= 4);
        if (t) { b.attack(t); this.log('sys', `Đánh ${t.displayName || t.name || t.type}`); }
        else { b.swingArm('right'); this.log('sys', 'Không có mục tiêu trong tầm, chỉ vung tay.'); }
      }
      else if (name === 'use') b.activateItem();
      else if (name === 'slot') b.setQuickBarSlot(Math.max(0, Math.min(8, Number(value) || 0)));
      else if (name === 'stop') b.clearControlStates();
    } catch (e) { this.log('err', e.message); }
  }
}

/* ---------- lưu / tải profile ---------- */
function save() {
  const data = [...sessions.values()].map(s => ({ id: s.id, cfg: s.cfg }));
  try { fs.writeFileSync(PROFILE_FILE, JSON.stringify(data, null, 2)); } catch (e) { console.error('Không lưu được profiles:', e.message); }
}
function load() {
  try {
    let raw;
    try { raw = fs.readFileSync(PROFILE_FILE, 'utf8'); }
    catch (e) { if (process.env.PROFILES_JSON) raw = process.env.PROFILES_JSON; else throw e; } // gói cấu hình qua biến môi trường (Render free không có ổ đĩa)
    const data = JSON.parse(raw);
    for (const d of data) {
      sessions.set(String(d.id), new Session(String(d.id), d.cfg));
      nextId = Math.max(nextId, Number(d.id) + 1 || 1);
    }
  } catch { /* chưa có file */ }
}

/* ---------- xử lý lệnh từ giao diện ---------- */
function handle(m) {
  if (m.type === 'add') {
    const id = String(nextId++);
    const s = new Session(id, m.cfg);
    sessions.set(id, s);
    save();
    broadcast({ type: 'summary', bot: s.summary() });
    if (m.connect) s.connect();
    return;
  }
  const s = sessions.get(String(m.id));
  if (!s) return;
  switch (m.type) {
    case 'update': s.update(m.cfg || {}); save(); break;
    case 'connect': s.connect(); break;
    case 'disconnect': s.disconnect(); break;
    case 'remove':
      s.disconnect(); sessions.delete(s.id); save();
      broadcast({ type: 'removed', id: s.id }); break;
    case 'chat': s.say(m.text); break;
    case 'control': s.control(m.key, m.on); break;
    case 'turn': s.turn(Number(m.yaw) || 0, Number(m.pitch) || 0); break;
    case 'action': s.action(m.name, m.value); break;
  }
}

/* ---------- đăng nhập web (bắt buộc khi mở ra Internet) ---------- */
const sessionToken = APP_PASSWORD
  ? crypto.createHmac('sha256', process.env.SESSION_SECRET || APP_PASSWORD).update('mc-bot-launcher-session').digest('hex')
  : '';
const safeEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
function getCookie(req, name) {
  const m = (req.headers.cookie || '').split(/;\s*/).find(c => c.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : '';
}
const isAuthed = (req) => !APP_PASSWORD || safeEq(getCookie(req, 'mcb_session'), sessionToken);
const clientIp = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
const failures = new Map(); // ip -> { n, until }
function tooMany(ip) { const f = failures.get(ip); return f && f.n >= 8 && Date.now() < f.until; }
function noteFail(ip) {
  const f = failures.get(ip);
  if (f && Date.now() < f.until) f.n++; else failures.set(ip, { n: 1, until: Date.now() + 10 * 60 * 1000 });
}

const LOGIN_PAGE = (msg) => `<!DOCTYPE html><html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Đăng nhập - MC Bot Launcher</title>
<style>:root{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#14181b;color:#dfe6e9;font:14px system-ui,sans-serif}
form{background:#1b2126;border:1px solid #2a343b;border-radius:10px;padding:24px;width:min(340px,90vw);display:grid;gap:12px}
h1{font-size:16px;margin:0}input,button{font:inherit;padding:9px 10px;border-radius:6px;border:1px solid #2a343b}
input{background:#0f1315;color:inherit}button{background:#7bc043;border-color:#7bc043;color:#0f1a08;font-weight:600;cursor:pointer}
p{margin:0;color:#ef6a5e}</style></head><body>
<form method="POST" action="/login"><h1>MC Bot Launcher</h1>${msg ? `<p>${msg}</p>` : ''}
<input type="password" name="password" placeholder="Mật khẩu truy cập" autofocus required>
<button type="submit">Đăng nhập</button></form></body></html>`;

function readBody(req, cb) {
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 2048) req.destroy(); });
  req.on('end', () => cb(new URLSearchParams(body)));
}

/* ---------- HTTP + WebSocket ---------- */
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const secure = String(req.headers['x-forwarded-proto'] || '').includes('https') || req.socket.encrypted;

  if (url === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }

  if (url === '/login' && req.method === 'POST') {
    const ip = clientIp(req);
    if (tooMany(ip)) { res.writeHead(429, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(LOGIN_PAGE('Thử sai quá nhiều lần, hãy đợi 10 phút.')); }
    return readBody(req, (form) => {
      if (APP_PASSWORD && safeEq(form.get('password') || '', APP_PASSWORD)) {
        failures.delete(ip);
        res.writeHead(302, {
          'Set-Cookie': `mcb_session=${sessionToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${secure ? '; Secure' : ''}`,
          Location: '/'
        });
        return res.end();
      }
      noteFail(ip);
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(LOGIN_PAGE('Sai mật khẩu.'));
    });
  }
  if (url === '/logout') {
    res.writeHead(302, { 'Set-Cookie': 'mcb_session=; HttpOnly; Path=/; Max-Age=0', Location: '/' });
    return res.end();
  }

  if (!isAuthed(req)) {
    if (url === '/' || url === '/index.html') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(LOGIN_PAGE('')); }
    res.writeHead(401); return res.end('Unauthorized');
  }

  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    fs.createReadStream(path.join(__dirname, 'public', 'index.html')).pipe(res);
  } else { res.writeHead(404); res.end('Not found'); }
});

// Chỉ cho trang cùng nguồn (cùng host) kết nối WebSocket + phải đăng nhập -> website lạ không điều khiển được bot
const extraOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const wss = new WebSocketServer({
  server,
  verifyClient: (info) => {
    if (!isAuthed(info.req)) return false;
    const origin = info.origin;
    if (!origin) return true;
    try {
      if (new URL(origin).host === info.req.headers.host) return true;
    } catch { return false; }
    return extraOrigins.includes(origin);
  }
});

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.send(JSON.stringify({ type: 'init', bots: [...sessions.values()].map(s => ({ ...s.summary(), logs: s.logs })) }));
  ws.on('message', (raw) => { try { handle(JSON.parse(raw)); } catch (e) { console.error('Lệnh lỗi:', e.message); } });
  ws.on('close', () => clients.delete(ws));
});

// ping định kỳ để proxy (Render, Nginx, Cloudflare) không cắt kết nối WebSocket khi không có hoạt động
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* bỏ qua */ }
  }
}, 25000);

// cập nhật thông số bot (vị trí, máu, ping...) mỗi giây
setInterval(() => {
  for (const s of sessions.values()) {
    const info = s.info();
    if (info) broadcast({ type: 'info', id: s.id, info });
  }
}, 1000);

// tránh sập cả chương trình vì lỗi gói tin lạ từ một bot
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e && e.message));
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e && e.message || e));

// tắt êm khi Render/systemd/Docker gửi SIGTERM: thoát bot trước, rồi mới dừng
function shutdown() {
  console.log('Đang tắt, ngắt kết nối các bot...');
  for (const s of sessions.values()) { s.manualStop = true; try { s.bot && s.bot.quit(); } catch { /* */ } }
  setTimeout(() => process.exit(0), 1500);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

load();
server.listen(HTTP_PORT, HOST, () => {
  const url = `http://localhost:${HTTP_PORT}`;
  console.log(`MC Bot Launcher đang chạy tại ${HOST}:${HTTP_PORT}${APP_PASSWORD ? ' (có mật khẩu)' : ''} | dữ liệu: ${DATA_DIR}`);
  // chỉ tự mở trình duyệt khi chạy cục bộ trên máy có giao diện đồ hoạ
  const hasGui = process.platform !== 'linux' || process.env.DISPLAY || process.env.WAYLAND_DISPLAY;
  if (IS_LOCAL && hasGui && !process.env.NO_OPEN) {
    const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
    exec(cmd, () => {});
  }
  // tự kết nối lại các bot đã bật "autoStart" (so le 2 giây để tránh bị server chặn vì vào dồn dập)
  let i = 0;
  for (const s of sessions.values()) if (s.cfg.autoStart) setTimeout(() => s.connect(), 2000 * i++);
});
