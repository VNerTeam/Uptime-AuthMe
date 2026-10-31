'use strict';
/**
 * Hỗ trợ di chuyển cho bot (không dùng pathfinder, rất nhẹ):
 *   1. Knockback  : ghi nhận khi bị đánh/nổ, tạm nhả phím di chuyển do PvP đặt để cú đẩy diễn ra tự nhiên
 *   2. Tự nhảy    : gặp bậc cao 1 block thì nhảy lên (như autojump)
 *   3. Thoát kẹt  : khi cứ nhấn đi tới mà không nhúc nhích và có vật cản ngay trước mặt
 *        a. nhảy + đặt block ngay dưới chân (trụ lên), rồi đi tiếp
 *        b. không đặt được block mà còn kẽ hở: ném ender pearl qua kẽ hở
 *        c. kín hết (hoặc không có pearl): cầm cúp đào 2 block (chân + đầu) ngay phía trước
 */
const { Vec3 } = require('vec3');

const PICK = { netherite_pickaxe: 6, diamond_pickaxe: 5, iron_pickaxe: 4, stone_pickaxe: 3, golden_pickaxe: 2, wooden_pickaxe: 1 };
const AXE = { netherite_axe: 6, diamond_axe: 5, iron_axe: 4, stone_axe: 3, golden_axe: 2, wooden_axe: 1 };
const SHOVEL = { netherite_shovel: 6, diamond_shovel: 5, iron_shovel: 4, stone_shovel: 3, golden_shovel: 2, wooden_shovel: 1 };
// chỉ dùng các loại block rẻ để đặt, tránh phí đồ quý (obsidian, block kim cương, tnt, rương...)
const PLACE_OK = /^(cobblestone|cobbled_deepslate|dirt|coarse_dirt|rooted_dirt|netherrack|stone|deepslate|andesite|diorite|granite|tuff|calcite|blackstone|basalt|end_stone|sandstone|red_sandstone|terracotta|stone_bricks|bricks|mud|clay|dripstone_block|[a-z_]+_planks|[a-z_]+_log)$/;
const PLACE_PREF = ['cobblestone', 'cobbled_deepslate', 'dirt', 'netherrack', 'stone', 'deepslate', 'andesite', 'diorite', 'granite', 'tuff', 'blackstone', 'end_stone'];
// không bao giờ đào những thứ này dù đang kẹt
const NO_DIG = /(chest|barrel|shulker|furnace|smoker|spawner|bedrock|barrier|command_block|portal|beacon|_bed$|sign|hopper|dropper|dispenser|lectern|jukebox|enchanting|anvil|crafting|brewing)/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, a, b) => Math.max(a, Math.min(b, Number(v) || 0));
const withTimeout = (p, ms, msg) => {
  p.catch(() => {});
  return Promise.race([p, sleep(ms).then(() => { throw new Error(msg || 'quá thời gian'); })]);
};

class Mover {
  constructor(session, bot) {
    this.s = session;
    this.bot = bot;
    this.escaping = false;
    this.kbUntil = 0;
    this.lastKbLog = 0;
    this.kbCount = 0;
    this.hist = [];
    this.intentSince = 0;
    this.stuckSince = 0;
    this.lastJump = 0;
    this.lastEscape = 0;
    this.cool = 3000;
    this.why = '';
    this.episode = { pillars: 0, pearls: 0 };

    bot._client.on('entity_velocity', (p) => {
      const v = p.velocity || { x: p.velocityX, y: p.velocityY, z: p.velocityZ };
      this.onKnockback(v.x / 8000, v.y / 8000, v.z / 8000, p.entityId);
    });
    bot._client.on('explosion', (p) => {
      const k = p.playerKnockback || (('playerMotionX' in p) ? { x: p.playerMotionX, y: p.playerMotionY, z: p.playerMotionZ } : null);
      if (k) this.onKnockback(k.x, k.y, k.z, bot.entity && bot.entity.id, true);
    });
    this.timer = setInterval(() => this.tick(), 50);
    session.timers.add(this.timer);
  }

  get c() { return this.s.cfg; }
  log(kind, text) { this.s.log(kind, '[Di chuyển] ' + text); }
  stop() { clearInterval(this.timer); }
  kbActive(now = Date.now()) { return this.c.kbRespect !== false && now < this.kbUntil; }
  alive() { const b = this.bot; return this.s.bot === b && this.s.state === 'online' && b.entity && b.health > 0; }

  /* ================= 1. knockback ================= */
  onKnockback(x, y, z, entityId, explosion) {
    const bot = this.bot;
    if (!bot.entity || entityId !== bot.entity.id) return;
    const mag = Math.hypot(x, y, z);
    if (mag < 0.05) return;
    this.kbCount++;
    this.kbUntil = Date.now() + clamp(this.c.kbHold || 350, 0, 2000);
    if (this.c.kbLog && Date.now() - this.lastKbLog > 400) {
      this.lastKbLog = Date.now();
      this.log('sys', `${explosion ? 'Vụ nổ' : 'Knockback'}: vx=${x.toFixed(2)} vy=${y.toFixed(2)} vz=${z.toFixed(2)} (lần ${this.kbCount})`);
    }
  }

  /* ================= đọc thế giới ================= */
  heightAt(x, y, z) {
    const b = this.bot.blockAt(new Vec3(Math.floor(x), y, Math.floor(z)));
    if (!b || b.boundingBox !== 'block') return 0;
    if (!b.shapes || !b.shapes.length) return 1;
    let h = 0;
    for (const s of b.shapes) h = Math.max(h, s[4]);
    return h;
  }
  solidAt(x, y, z) { return this.heightAt(x, y, z) > 0; }

  intentDir() {
    const cs = this.bot.controlState;
    const f = (cs.forward ? 1 : 0) - (cs.back ? 1 : 0);
    const st = (cs.right ? 1 : 0) - (cs.left ? 1 : 0);
    if (!f && !st) return null;
    const yaw = this.bot.entity.yaw, sin = Math.sin(yaw), cos = Math.cos(yaw);
    const x = -(st * cos + f * sin), z = -(f * cos - st * sin);
    const n = Math.hypot(x, z);
    return n ? { x: x / n, z: z / n } : null;
  }

  blockedAhead(dir) {
    const p = this.bot.entity.position, fy = Math.floor(p.y + 0.001);
    const ax = p.x + dir.x * 0.6, az = p.z + dir.z * 0.6;
    return this.heightAt(ax, fy, az) > 0.6 || this.heightAt(ax, fy + 1, az) > 0;
  }

  /* ================= vòng lặp ================= */
  tick() {
    try {
      const bot = this.bot, c = this.c;
      if (this.s.bot !== bot || this.s.state !== 'online' || !bot.entity || this.escaping) return;
      const now = Date.now(), e = bot.entity;
      this.hist.push({ t: now, x: e.position.x, z: e.position.z });
      while (this.hist.length && now - this.hist[0].t > 1500) this.hist.shift();

      const dir = this.intentDir();
      if (!dir) { this.intentSince = 0; this.stuckSince = 0; return; }
      if (!this.intentSince) this.intentSince = now;
      if (c.autoJump !== false) this.autoJump(dir, now);

      // chỉ coi là "kẹt" khi đang nhấn đi tới
      if (!c.stuckEnabled || !bot.controlState.forward || bot.controlState.back) { this.stuckSince = 0; return; }
      if (now < this.kbUntil || now - this.intentSince < 700) { this.stuckSince = 0; return; }
      const old = this.hist.find((h) => now - h.t <= 700);
      const moved = old ? Math.hypot(e.position.x - old.x, e.position.z - old.z) : 99;
      const still = old && now - old.t >= 600 && moved < 0.2 && (e.onGround || e.isInWater);
      if (still) { if (!this.stuckSince) this.stuckSince = now; } else { this.stuckSince = 0; this.cool = 3000; }

      if (this.stuckSince && now - this.stuckSince >= clamp(c.stuckAfter || 1.5, 0.5, 30) * 1000 &&
          now - this.lastEscape > this.cool && this.blockedAhead(dir)) {
        this.escape(dir);
      }
    } catch (err) { this.dbg(err); }
  }
  dbg(err) { if (Date.now() - this.lastKbLog > 5000) { this.lastKbLog = Date.now(); this.log('warn', 'lỗi: ' + (err && err.message || err)); } }

  /* ================= 2. tự nhảy ================= */
  autoJump(dir, now) {
    const bot = this.bot, e = bot.entity;
    if (!e.onGround || now - this.lastJump < 350 || bot.controlState.jump) return;
    const p = e.position, fy = Math.floor(p.y + 0.001);
    const ax = p.x + dir.x * 0.6, az = p.z + dir.z * 0.6;
    const h = this.heightAt(ax, fy, az);
    if (h <= 0.6 || h > 1.25) return;                         // bậc thấp (slab/thang) tự bước được; quá cao thì nhảy cũng không lên
    if (this.solidAt(ax, fy + 1, az) || this.solidAt(ax, fy + 2, az)) return; // phía trên bậc phải trống
    if (this.solidAt(p.x, fy + 2, p.z)) return;               // đầu mình phải có chỗ nhảy
    this.lastJump = now;
    bot.setControlState('jump', true);
    setTimeout(() => { try { bot.setControlState('jump', false); } catch { /* */ } }, 220);
  }

  /* ================= 3. thoát kẹt ================= */
  has(name) { return this.bot.inventory.items().find((i) => i.name === name) || null; }
  pickPlaceable() {
    const items = this.bot.inventory.items().filter((i) => PLACE_OK.test(i.name));
    items.sort((a, b) => {
      const ia = PLACE_PREF.indexOf(a.name), ib = PLACE_PREF.indexOf(b.name);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || b.count - a.count;
    });
    return items[0] || null;
  }
  bestTool() {
    const items = this.bot.inventory.items();
    for (const table of [PICK, AXE, SHOVEL]) {
      const t = items.filter((i) => table[i.name]).sort((a, b) => table[b.name] - table[a.name])[0];
      if (t) return t;
    }
    return null;
  }

  async escape(dir) {
    const bot = this.bot, c = this.c;
    this.escaping = true;
    this.lastEscape = Date.now();
    this.episode = { pillars: 0, pearls: 0 };
    const snap = {};
    for (const k of ['forward', 'back', 'left', 'right', 'sprint', 'jump', 'sneak']) snap[k] = !!bot.controlState[k];
    for (const k of Object.keys(snap)) bot.setControlState(k, false);
    const start = bot.entity.position.clone();
    let solved = false;
    try {
      this.log('warn', `Bị kẹt tại ${start.x.toFixed(1)}, ${start.y.toFixed(1)}, ${start.z.toFixed(1)}, đang thử thoát...`);
      for (let round = 0; round < 7 && this.alive(); round++) {
        if (round > 0 && (Math.hypot(bot.entity.position.x - start.x, bot.entity.position.z - start.z) >= 1.5 || !this.blockedAhead(dir))) { solved = true; break; }
        const how = await this.escapeStep(dir, c);
        if (!how) break;
      }
      if (!solved && this.alive() && !this.blockedAhead(dir)) solved = true;
      this.log(solved ? 'sys' : 'err', solved ? 'Đã thoát kẹt, đi tiếp.' : `Chưa thoát được${this.why ? ' (' + this.why + ')' : ''}.`);
    } catch (err) {
      this.log('err', 'Lỗi khi thoát kẹt: ' + (err && err.message || err));
    } finally {
      try {
        bot.setControlState('jump', false);
        for (const k of ['forward', 'back', 'left', 'right', 'sprint', 'sneak']) bot.setControlState(k, snap[k]);
      } catch { /* */ }
      if (this.s.pvp && this.s.pvp.syncCache) this.s.pvp.syncCache();
      this.cool = solved ? 3000 : Math.min(30000, this.cool * 2);
      this.lastEscape = Date.now();
      this.hist = []; this.stuckSince = 0; this.intentSince = 0;
      this.escaping = false;
    }
  }

  // một bước thoát kẹt: trả về tên cách đã làm, hoặc null nếu hết cách
  async escapeStep(dir, c) {
    this.why = '';
    if (c.stuckPlace !== false && this.episode.pillars < 6) {
      if (await this.pillarUp()) { this.episode.pillars++; await this.walk(dir, 450); return 'pillar'; }
      this.log('sys', 'Không trụ block được: ' + this.why);
    }
    // không đặt được block dưới chân: xem có kẽ hở để ném pearl không
    const gap = c.stuckPearl !== false && this.episode.pearls < 2 ? this.findGap(dir) : null;
    if (gap) {
      if (!this.has('ender_pearl')) this.log('sys', 'Có kẽ hở nhưng không có ender pearl.');
      else if (await this.throwPearl(gap)) { this.episode.pearls++; return 'pearl'; }
      else this.log('sys', 'Ném pearl không thành: ' + this.why);
    } else if (c.stuckPearl !== false) this.log('sys', 'Không có kẽ hở để ném pearl (kín hết).');
    // kín hết (hoặc không còn cách khác): đào
    if (c.stuckDig !== false) {
      if (await this.digAhead(dir)) return 'dig';
    }
    return null;
  }

  async walk(dir, ms) {
    const bot = this.bot;
    bot.setControlState('forward', true);
    await sleep(ms);
    bot.setControlState('forward', false);
  }

  /** nhảy lên rồi đặt block vào ô đang đứng (trụ lên 1 block) */
  async pillarUp() {
    const bot = this.bot, e = bot.entity;
    const item = this.pickPlaceable();
    if (!item) { this.why = 'không có block rẻ để đặt (cobblestone, dirt...)'; return false; }
    const base = e.position.floored();
    const below = bot.blockAt(base.offset(0, -1, 0));
    if (!below || below.boundingBox !== 'block') { this.why = 'không có chỗ đứng để đặt block'; return false; }
    if (this.solidAt(base.x + 0.5, base.y + 2, base.z + 0.5)) { this.why = 'trần thấp, không nhảy được'; return false; }
    try {
      await bot.equip(item, 'hand');
      await bot.look(e.yaw, -1.45, true);
      bot.setControlState('jump', true);
      const t0 = Date.now();
      while (Date.now() - t0 < 700 && e.position.y < base.y + 1.05) await sleep(25);
      bot.setControlState('jump', false);
      if (e.position.y < base.y + 1.0) { this.why = 'nhảy không đủ cao'; return false; }
      let placeErr = '';
      try { await withTimeout(bot.placeBlock(below, new Vec3(0, 1, 0)), 2500, 'server không xác nhận đặt block'); }
      catch (err) { placeErr = err && err.message || String(err); }   // vẫn kiểm tra thực tế bên dưới
      await sleep(250);
      await bot.look(e.yaw, 0, true);
      const ok = this.solidAt(base.x + 0.5, base.y, base.z + 0.5);   // block có thật sự nằm ở ô chân không
      if (!ok) this.why = 'đặt block không thành công' + (placeErr ? ' (' + placeErr + ')' : '');
      return ok;
    } catch (err) {
      bot.setControlState('jump', false);
      this.why = 'không đặt được block: ' + (err && err.message || err);
      return false;
    }
  }

  /* ----- ender pearl ----- */
  // mô phỏng quỹ đạo ender pearl (tốc độ 1.5, cản 0.99, trọng lực 0.03)
  simPearl(eye, yaw, pitch) {
    const bot = this.bot;
    const cp = Math.cos(pitch);
    let vx = -Math.sin(yaw) * cp * 1.5, vy = Math.sin(pitch) * 1.5, vz = -Math.cos(yaw) * cp * 1.5;
    let x = eye.x, y = eye.y - 0.1, z = eye.z, px = x, py = y, pz = z;
    for (let tick = 0; tick < 90; tick++) {
      for (let s = 0; s < 4; s++) {
        const nx = x + vx / 4, ny = y + vy / 4, nz = z + vz / 4;
        const b = bot.blockAt(new Vec3(Math.floor(nx), Math.floor(ny), Math.floor(nz)));
        if (!b) return null;                                  // chunk chưa tải
        if (b.boundingBox === 'block') return { x: px, y: py, z: pz, flight: Math.hypot(px - eye.x, py - eye.y, pz - eye.z) };
        px = x = nx; py = y = ny; pz = z = nz;
      }
      vx *= 0.99; vy = vy * 0.99 - 0.03; vz *= 0.99;
      if (y < bot.entity.position.y - 40) return null;       // rơi vào hư không
    }
    return null;
  }

  landingOk(p) {
    const bot = this.bot;
    const cx = Math.floor(p.x), cy = Math.floor(p.y), cz = Math.floor(p.z);
    const feet = bot.blockAt(new Vec3(cx, cy, cz)), head = bot.blockAt(new Vec3(cx, cy + 1, cz));
    if (!feet || !head || feet.boundingBox === 'block' || head.boundingBox === 'block') return false;
    for (let d = 1; d <= 5; d++) {
      const g = bot.blockAt(new Vec3(cx, cy - d, cz));
      if (!g) return false;
      if (/lava|fire|magma|cactus|campfire/.test(g.name)) return false;
      if (g.boundingBox === 'block' || /water/.test(g.name)) return true;
    }
    return false;                                              // rơi quá cao
  }

  /** tìm hướng ném mà pearl bay thoát khỏi chỗ kín và rơi xuống chỗ an toàn */
  findGap(dir) {
    const bot = this.bot, e = bot.entity;
    const eye = e.position.offset(0, 1.62, 0);
    const baseYaw = Math.atan2(-dir.x, -dir.z);
    let best = null, bestScore = -Infinity;
    for (let k = 0; k <= 9; k++) {
      for (const sign of (k === 0 ? [1] : [1, -1])) {
        const yaw = baseYaw + sign * k * (Math.PI / 9);
        for (const pitch of [0.05, 0.25, 0.45, 0.65, 0.85, -0.15]) {
          const r = this.simPearl(eye, yaw, pitch);
          if (!r || r.flight < 5 || !this.landingOk(r)) continue;
          const dx = r.x - e.position.x, dz = r.z - e.position.z;
          if (Math.hypot(dx, dz) < 4) continue;
          const fwd = dx * dir.x + dz * dir.z;
          if (fwd < 2.5) continue;                            // phải rơi ở phía trước vật cản, ném ngược lại thì vô ích
          const score = fwd - Math.abs(sign * k) * 0.8 - Math.abs(pitch) * 1.5;
          if (score > bestScore) { bestScore = score; best = { yaw, pitch, land: r }; }
        }
      }
    }
    return best;
  }

  async throwPearl(gap) {
    const bot = this.bot;
    const pearl = this.has('ender_pearl');
    if (!pearl) return false;
    try {
      await bot.equip(pearl, 'hand');
      await bot.look(gap.yaw, gap.pitch, true);
      await sleep(150);
      const p0 = bot.entity.position.clone();
      bot.activateItem();
      this.log('sys', `Ném ender pearl qua kẽ hở (hướng ${(gap.yaw * 180 / Math.PI).toFixed(0)}°, rơi cách ~${gap.land.flight.toFixed(0)} block).`);
      const t0 = Date.now();
      while (Date.now() - t0 < 4500) {
        await sleep(100);
        if (bot.entity.position.distanceTo(p0) > 2.5) { await sleep(300); return true; }
      }
      this.why = 'pearl không dịch chuyển được';
      return false;
    } catch (err) { this.why = 'lỗi ném pearl: ' + (err && err.message || err); return false; }
  }

  /* ----- đào ----- */
  lavaNear(cell) {
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 2; dy++) for (let dz = -1; dz <= 1; dz++) {
      const b = this.bot.blockAt(cell.offset(dx, dy, dz));
      if (b && /lava/.test(b.name)) return true;
    }
    return false;
  }

  /** đào 2 block (ngang chân và ngang đầu) ngay phía trước theo hướng đang đi */
  async digAhead(dir) {
    const bot = this.bot, e = bot.entity;
    const step = Math.abs(dir.x) >= Math.abs(dir.z) ? [Math.sign(dir.x), 0] : [0, Math.sign(dir.z)];
    const base = e.position.floored();
    const cells = [base.offset(step[0], 0, step[1]), base.offset(step[0], 1, step[1])];
    let dug = 0;
    try {
      const tool = this.bestTool();
      if (tool) await bot.equip(tool, 'hand');
      for (const cell of cells) {
        const b = bot.blockAt(cell);
        if (!b || b.boundingBox !== 'block') continue;
        if (NO_DIG.test(b.name)) { this.why = `không đào ${b.name}`; return dug > 0; }
        if (this.lavaNear(cell)) { this.why = 'gần dung nham nên không đào'; return dug > 0; }
        if (!b.diggable) { this.why = `${b.name} không đào được`; return dug > 0; }
        await withTimeout(bot.dig(b, true), 20000, 'đào quá lâu');
        dug++;
      }
      if (dug) {
        this.log('sys', `Đã đào ${dug} block phía trước.`);
        await this.walk(dir, 900);
      } else this.why = 'phía trước đã trống, không có gì để đào';
    } catch (err) { this.why = 'lỗi đào: ' + (err && err.message || err); }
    return dug > 0;
  }
}

module.exports = { Mover };
