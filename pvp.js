'use strict';
/**
 * PvP tự động - bản nhẹ cho VPS ít RAM (không dùng mineflayer-pathfinder / mineflayer-pvp).
 * Các nhóm chức năng, mỗi nhóm bật/tắt riêng trong cấu hình bot:
 *   1. Chung        : chọn mục tiêu, danh sách bỏ qua, chỉ đánh trả, né (strafe)
 *   2. Kiếm / Rìu   : tự chọn vũ khí, chờ hồi chiêu, đòn chí mạng, rìu phá khiên
 *   3. End Crystal  : đặt tinh thể lên obsidian/bedrock gần mục tiêu rồi đập nổ
 *   4. Auto Totem   : luôn giữ Totem trong tay trái
 *   5. Ăn & Giáp    : tự ăn, ăn táo vàng khi máu thấp, tự mặc giáp tốt nhất
 *   6. An toàn      : chạy lui khi máu thấp, tự thoát server khi máu quá thấp
 */
const { Vec3 } = require('vec3');

const SWORD = { netherite_sword: 8, diamond_sword: 7, iron_sword: 6, stone_sword: 5, golden_sword: 4, wooden_sword: 4 };
const AXE = { netherite_axe: 10, diamond_axe: 9, iron_axe: 9, stone_axe: 9, golden_axe: 7, wooden_axe: 7 };
const AXE_SPEED = { netherite_axe: 1.0, diamond_axe: 1.0, golden_axe: 1.0, wooden_axe: 0.8, stone_axe: 0.8, iron_axe: 0.9 };
const ARMOR_TIER = { netherite: 6, diamond: 5, iron: 4, chainmail: 3, golden: 2, leather: 1, turtle: 1 };
const ARMOR_PARTS = [['helmet', 'head', 5], ['chestplate', 'torso', 6], ['leggings', 'legs', 7], ['boots', 'feet', 8]];
const BAD_FOOD = new Set(['rotten_flesh', 'poisonous_potato', 'pufferfish', 'spider_eye', 'chorus_fruit', 'suspicious_stew', 'raw_chicken', 'chicken']);
const OFFHAND = 45;
const HIT_REACH = 4.0;   // khoảng cách từ mắt tới tâm crystal để đập được (hitbox crystal rộng 2 block)

const clamp = (v, a, b) => Math.max(a, Math.min(b, Number(v) || 0));
const armorTier = (name) => ARMOR_TIER[String(name).split('_')[0]] || 0;
const isAir = (b) => !b || b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air';

// Ước lượng THÔ sát thương vụ nổ crystal (sức nổ 6, chưa tính phơi nhiễm/độ khó/phép giáp)
function crystalDamage(dist) {
  if (dist >= 12) return 0;
  const impact = 1 - dist / 12;
  return ((impact * impact + impact) / 2) * 7 * 12 + 1;
}

class Pvp {
  constructor(session, bot) {
    this.s = session;
    this.bot = bot;
    this.busy = false;
    this.target = null;
    this.aggressor = null;
    this.aggressorUntil = 0;
    this.cs = {};                    // trạng thái phím điều khiển do PvP đặt
    this.nextAttack = 0;
    this.jumpAt = 0;
    this.strafeDir = 0;
    this.strafeUntil = 0;
    this.shieldUntil = 0;
    this.combatUntil = 0;
    this.last = { equip: 0, place: 0, eat: 0, armor: 0, totem: 0, crystalScan: 0, log: 0 };
    this.pops = 0;
    this.loggedOut = false;
    this.ignoreKey = null;
    this.ignoreSet = new Set();

    bot.on('entityHurt', (e) => this.onHurt(e));
    bot._client.on('entity_status', (p) => {
      if (bot.entity && p.entityId === bot.entity.id && p.entityStatus === 35) {
        this.pops++;
        this.s.log('warn', `[PvP] Totem vừa vỡ (lần ${this.pops}).`);
      }
    });
    this.timer = setInterval(() => this.tick(), 100);
    session.timers.add(this.timer);
  }

  get c() { return this.s.cfg; }
  dbg(label, e) { if (Date.now() - this.last.log > 5000) { this.last.log = Date.now(); this.s.log('warn', `[PvP] ${label}: ${e && e.message || e}`); } }
  status() { return this.target ? this.target.username : null; }
  stop() { clearInterval(this.timer); this.releaseMoves(); }

  run(fn, label) {
    this.busy = true;
    Promise.resolve().then(fn).catch((e) => this.dbg(label || 'lỗi', e)).finally(() => { this.busy = false; });
  }
  ctl(k, on) {
    if (this.cs[k] === on) return;
    this.cs[k] = on;
    try { this.bot.setControlState(k, on); } catch { /* bỏ qua */ }
  }
  releaseMoves() {
    for (const k of Object.keys(this.cs)) if (this.cs[k]) this.ctl(k, false);
  }
  has(name) { return this.bot.inventory.items().find((i) => i.name === name) || null; }

  onHurt(entity) {
    const bot = this.bot;
    if (!bot.entity || entity !== bot.entity) return;
    let best = null, bd = 6.5;
    for (const e of Object.values(bot.entities)) {
      if (e.type !== 'player' || e === bot.entity || !e.username) continue;
      const d = bot.entity.position.distanceTo(e.position);
      if (d < bd) { bd = d; best = e; }
    }
    if (best) { this.aggressor = best.username; this.aggressorUntil = Date.now() + 15000; }
  }

  /* ================= vòng lặp chính ================= */
  tick() {
    try {
      const bot = this.bot, c = this.c;
      if (this.s.bot !== bot || this.s.state !== 'online' || !bot.entity) return;
      const now = Date.now();

      // đang thoát kẹt: Mover điều khiển, PvP tạm dừng
      if (this.s.mover && this.s.mover.escaping) return;

      // 6. An toàn: thoát khi máu quá thấp
      if (c.logoutHp > 0 && bot.health > 0 && bot.health <= c.logoutHp && !this.loggedOut) {
        this.loggedOut = true;
        this.s.log('err', `[PvP] Máu ${bot.health} ≤ ${c.logoutHp}, tự thoát server để bảo toàn đồ.`);
        this.s.disconnect();
        return;
      }

      // 4/5. Nhóm hỗ trợ (chạy lần lượt, không chồng nhau)
      if (!this.busy && this.support(now)) return;

      if (!c.pvpEnabled && !c.crystalEnabled) { this.target = null; this.releaseMoves(); return; }
      this.fight(now);
    } catch (e) { this.dbg('tick', e); }
  }

  support(now) {
    const bot = this.bot, c = this.c;

    // 4. Auto Totem: luôn giữ totem ở tay trái
    if (c.totemEnabled && now - this.last.totem > 400 && !bot.registry.isOlderThan('1.11')) {
      const off = bot.inventory.slots[OFFHAND];
      if (!off || off.name !== 'totem_of_undying') {
        const t = this.has('totem_of_undying');
        if (t) {
          this.last.totem = now;
          this.run(() => bot.equip(t, 'off-hand'), 'đổi totem');
          return true;
        }
      }
    }

    // 5a. Táo vàng khi máu thấp
    if (c.gapEnabled && bot.health <= clamp(c.gapHp, 1, 19) && now - this.last.eat > 2500) {
      const pref = bot.health <= 6 ? ['enchanted_golden_apple', 'golden_apple'] : ['golden_apple', 'enchanted_golden_apple'];
      const apple = pref.map((n) => this.has(n)).find(Boolean);
      if (apple) { this.last.eat = now; this.eat(apple); return true; }
    }

    // 5b. Ăn thường khi đói (không ăn lúc đang đánh nhau)
    if (c.eatEnabled && bot.food <= clamp(c.eatFood, 1, 19) && now > this.combatUntil && now - this.last.eat > 3000) {
      const foods = bot.registry.foodsByName || {};
      const pick = bot.inventory.items()
        .filter((i) => foods[i.name] && !BAD_FOOD.has(i.name) && !/golden_apple/.test(i.name))
        .sort((a, b) => foods[b.name].foodPoints - foods[a.name].foodPoints)[0];
      if (pick) { this.last.eat = now; this.eat(pick); return true; }
    }

    // 5c. Tự mặc giáp tốt nhất
    if (c.armorEnabled && now - this.last.armor > 3000) {
      this.last.armor = now;
      for (const [part, dest, slot] of ARMOR_PARTS) {
        const cur = bot.inventory.slots[slot];
        const curScore = cur ? armorTier(cur.name) : 0;
        const best = bot.inventory.items()
          .filter((i) => i.name.endsWith('_' + part))
          .sort((a, b) => armorTier(b.name) - armorTier(a.name))[0];
        if (best && armorTier(best.name) > curScore) {
          this.run(() => bot.equip(best, dest), 'mặc giáp');
          this.s.log('sys', `[PvP] Mặc ${best.name}.`);
          return true;
        }
      }
    }
    return false;
  }

  eat(item) {
    const bot = this.bot;
    this.releaseMoves();
    this.run(async () => {
      await bot.equip(item, 'hand');
      await bot.consume();
    }, 'ăn');
  }

  /* ================= chọn mục tiêu ================= */
  parseIgnore() {
    const raw = String(this.c.pvpIgnore || '');
    if (raw !== this.ignoreKey) {
      this.ignoreKey = raw;
      this.ignoreSet = new Set(raw.split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean));
    }
    return this.ignoreSet;
  }

  validTarget(e, now) {
    const bot = this.bot, c = this.c;
    if (!e || e.type !== 'player' || e === bot.entity || !e.username) return false;
    if (this.parseIgnore().has(e.username.toLowerCase())) return false;
    const pl = bot.players[e.username];
    // NPC giả thường không có trong tab list. Chỉ lọc khi tab list có vẻ đầy đủ (server ẩn tab list thì không lọc)
    if (!pl && Object.keys(bot.players).length > 1) return false;
    if (pl && (pl.gamemode === 1 || pl.gamemode === 3)) return false; // creative / spectator không đánh được
    if (e.health !== undefined && e.health !== null && e.health <= 0) return false;
    if (bot.entity.position.distanceTo(e.position) > clamp(c.pvpRange, 3, 32)) return false;
    if (c.pvpMode === 'retaliate' && !(this.aggressor === e.username && now < this.aggressorUntil)) return false;
    return true;
  }

  pickTarget(now) {
    const bot = this.bot;
    if (this.target && bot.entities[this.target.id] && this.validTarget(this.target, now)) return this.target;
    let best = null, bd = Infinity;
    for (const e of Object.values(bot.entities)) {
      if (!this.validTarget(e, now)) continue;
      const d = bot.entity.position.distanceTo(e.position);
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  }

  /* ================= chiến đấu ================= */
  fight(now) {
    const bot = this.bot, c = this.c;
    const target = this.pickTarget(now);
    if (target !== this.target) {
      this.s.log('sys', target ? `[PvP] Mục tiêu: ${target.username}` : '[PvP] Hết mục tiêu.');
      this.target = target;
    }
    if (!target) { this.releaseMoves(); return; }
    if (this.busy) return;

    this.combatUntil = now + 5000;
    const me = bot.entity.position;
    const d = me.distanceTo(target.position);
    const reach = clamp(c.pvpReach || 3, 2.5, 4.5);

    // 6. Chạy lui khi máu thấp
    if (c.retreatHp > 0 && bot.health <= c.retreatHp) { this.retreat(target); return; }

    // 3. End Crystal (khi ở xa tầm đánh gần)
    if (c.crystalEnabled && d > reach + 0.6 && this.has('end_crystal')) {
      if (this.crystalStep(target, now, d)) return;
    }

    if (!c.pvpEnabled) { this.releaseMoves(); return; }

    // 2. Chọn vũ khí
    const w = this.pickWeapon(target, now);
    const held = bot.heldItem;
    if (w && (!held || held.name !== w.name)) {
      if (now - this.last.equip > 350) { this.last.equip = now; this.run(() => bot.equip(w, 'hand'), 'đổi vũ khí'); }
      return;
    }

    // nhìn vào mục tiêu
    const aim = target.position.offset(0, (target.height || 1.8) * 0.85, 0);
    bot.lookAt(aim, true).catch(() => {});

    this.chase(d, reach, now);
    this.melee(target, d, reach, now, held);
  }

  pickWeapon(target, now) {
    const c = this.c;
    const items = this.bot.inventory.items();
    const best = (table) => items.filter((i) => table[i.name]).sort((a, b) => table[b.name] - table[a.name])[0] || null;
    const sword = best(SWORD), axe = best(AXE);
    const eq = target.equipment || [];
    if (eq.some((i, idx) => idx < 2 && i && i.name === 'shield')) this.shieldUntil = now + 2000;
    const mode = c.pvpWeapon;
    let w;
    if (mode === 'sword') w = sword || axe;
    else if (mode === 'axe') w = axe || sword;
    else {
      w = sword || axe;
      if (c.pvpShieldBreak && now < this.shieldUntil && axe) w = axe;   // rìu làm vô hiệu hoá khiên
    }
    return w;
  }

  cooldown(held) {
    const bot = this.bot;
    if (bot.registry.isOlderThan('1.9')) return 120;       // 1.8 không có hồi chiêu
    if (!held) return 250;
    if (SWORD[held.name]) return 625;
    if (AXE[held.name]) return Math.round(1000 / (AXE_SPEED[held.name] || 1));
    if (held.name === 'mace') return 1667;
    return 300;
  }

  syncCache() {
    for (const k of Object.keys(this.cs)) this.cs[k] = !!this.bot.controlState[k];
  }

  chase(d, reach, now) {
    const bot = this.bot, c = this.c;
    const e = bot.entity;
    // vừa bị knockback/nổ: nhả phím di chuyển để cú đẩy diễn ra tự nhiên, không chạy ngược lại ngay
    if (this.s.mover && this.s.mover.kbActive(now)) {
      for (const k of ['forward', 'back', 'sprint', 'left', 'right']) this.ctl(k, false);
      return;
    }
    const falling = !e.onGround;
    this.ctl('forward', d > reach - 0.4);
    this.ctl('back', d < 1.4);
    this.ctl('sprint', d > 4 && !(c.pvpCrit && falling));    // đang rơi để chí mạng thì không chạy nhanh
    const stuck = e.isCollidedHorizontally && e.onGround;
    this.ctl('jump', now - this.jumpAt < 120 || stuck);
    if (c.pvpStrafe && d < 5 && d > 1.6) {
      if (now > this.strafeUntil) { this.strafeDir = [-1, 0, 1][Math.floor(Math.random() * 3)]; this.strafeUntil = now + 500 + Math.random() * 700; }
      this.ctl('left', this.strafeDir < 0);
      this.ctl('right', this.strafeDir > 0);
    } else { this.ctl('left', false); this.ctl('right', false); }
  }

  melee(target, d, reach, now, held) {
    const bot = this.bot, c = this.c, e = bot.entity;
    if (d > reach) return;
    const crit = c.pvpCrit && !e.isInWater && !e.isInLava;
    if (crit) {
      if (e.onGround) {
        // nhảy sớm ~280ms để lúc hồi chiêu xong thì đang rơi xuống
        if (now >= this.nextAttack - 280 && now - this.jumpAt > 700) { this.jumpAt = now; this.ctl('jump', true); }
        return;
      }
      const falling = e.velocity.y < -0.05;
      if (!falling && now - this.jumpAt < 650) return;
    }
    if (now < this.nextAttack) return;
    bot.attack(target);
    this.nextAttack = now + this.cooldown(held) + Math.random() * 60;
  }

  retreat(target) {
    const bot = this.bot, p = bot.entity.position, t = target.position;
    const dx = p.x - t.x, dz = p.z - t.z;
    bot.look(Math.atan2(-dx, -dz), 0, true).catch(() => {});
    const kb = this.s.mover && this.s.mover.kbActive(Date.now());
    this.ctl('forward', !kb); this.ctl('sprint', !kb); this.ctl('back', false);
    this.ctl('left', false); this.ctl('right', false);
    this.ctl('jump', bot.entity.isCollidedHorizontally);
  }

  /* ================= End Crystal ================= */
  armorFactor() {
    let n = 0;
    for (const s of [5, 6, 7, 8]) if (this.bot.inventory.slots[s]) n++;
    return Math.max(0.2, 1 - 0.2 * n);   // ước lượng thô: mỗi mảnh giáp giảm ~20%, tối đa giảm 80%
  }
  selfDamage(pos) { return crystalDamage(this.bot.entity.position.offset(0, 0.9, 0).distanceTo(pos)) * this.armorFactor(); }
  targetDamage(target, pos) { return crystalDamage(target.position.offset(0, 0.9, 0).distanceTo(pos)) * 0.5; }

  entityNear(x, y, z) {
    for (const e of Object.values(this.bot.entities)) {
      const dx = e.position.x - x, dz = e.position.z - z;
      if (dx * dx + dz * dz < 0.81 && e.position.y > y - 0.9 && e.position.y < y + 2) return true;
    }
    return false;
  }

  crystalStep(target, now, d) {
    const bot = this.bot, c = this.c;
    const maxSelf = clamp(c.crystalMaxSelf || 8, 1, 40);
    const eye = bot.entity.position.offset(0, 1.62, 0);
    this.releaseHold();

    // (a) đập crystal đang có gần mục tiêu
    const crystals = Object.values(bot.entities).filter((e) => e.name === 'end_crystal');
    const mine = crystals
      .filter((e) => e.position.distanceTo(target.position) <= 7)
      .sort((a, b) => a.position.distanceTo(target.position) - b.position.distanceTo(target.position));
    if (mine.length) {
      const cr = mine[0];
      const est = this.selfDamage(cr.position);
      if (est <= maxSelf && bot.health - est > 2) {
        const center = cr.position.offset(0, 1, 0);
        bot.lookAt(center, true).catch(() => {});
        if (center.distanceTo(eye) <= HIT_REACH) { bot.attack(cr); this.ctl('forward', false); }
        else this.ctl('forward', true);           // crystal hơi xa, tiến lại gần để đập
        this.ctl('back', false);
        return true;
      }
      return this.keepDistance(d, target);        // crystal này quá nguy hiểm cho mình: không đập, giữ khoảng cách
    }

    // (b) đặt crystal mới
    if (now - this.last.place < 250 || now - this.last.crystalScan < 120) return false;
    if (bot.health < clamp(c.crystalMinHp || 10, 1, 20)) return false;
    this.last.crystalScan = now;
    const plan = this.findCrystalSpot(target, eye, maxSelf);
    if (!plan) return false;

    const need = plan.kind === 'new' ? 'obsidian' : 'end_crystal';
    const item = this.has(need);
    if (!item) return false;
    if (!bot.heldItem || bot.heldItem.name !== need) {
      if (now - this.last.equip > 300) { this.last.equip = now; this.run(() => bot.equip(item, 'hand'), 'cầm ' + need); }
      return true;
    }
    this.last.place = now;
    if (plan.kind === 'new') this.run(() => bot.placeBlock(plan.block, new Vec3(0, 1, 0)), 'đặt obsidian');
    else this.run(() => bot.activateBlock(plan.block, new Vec3(0, 1, 0)), 'đặt crystal');
    return this.keepDistance(d, target) || true;
  }

  releaseHold() { this.ctl('jump', false); this.ctl('sprint', false); }

  keepDistance(d, target) {
    const bot = this.bot;
    bot.lookAt(target.position.offset(0, 1.4, 0), true).catch(() => {});
    this.ctl('forward', d > 6);
    this.ctl('back', d < 4);
    this.ctl('left', false); this.ctl('right', false);
    return true;
  }

  findCrystalSpot(target, eye, maxSelf) {
    const bot = this.bot, c = this.c;
    const tp = target.position.floored();
    const canObs = !!c.crystalObsidian && !!this.has('obsidian');
    let best = null, bestScore = -Infinity;
    for (let dx = -3; dx <= 3; dx++) {
      for (let dz = -3; dz <= 3; dz++) {
        for (const dy of [-1, 0]) {
          const bx = tp.x + dx, by = tp.y + dy, bz = tp.z + dz;
          const base = bot.blockAt(new Vec3(bx, by, bz));
          if (!base) continue;
          let kind = null;
          if (base.name === 'obsidian' || base.name === 'bedrock') kind = 'crystal';
          else if (canObs && dy === -1 && !isAir(base) && base.boundingBox === 'block' && (dx !== 0 || dz !== 0) && Math.abs(dx) <= 2 && Math.abs(dz) <= 2) kind = 'new';
          if (!kind) continue;
          // với 'new': obsidian sẽ nằm ở by+1, crystal ở by+2
          const top = kind === 'new' ? by + 1 : by;
          if (!isAir(bot.blockAt(new Vec3(bx, top + 1, bz))) || !isAir(bot.blockAt(new Vec3(bx, top + 2, bz)))) continue;
          if (kind === 'new' && !isAir(bot.blockAt(new Vec3(bx, top, bz)))) continue;
          const standPos = new Vec3(bx + 0.5, top + 1, bz + 0.5);
          if (eye.distanceTo(new Vec3(bx + 0.5, by + 1, bz + 0.5)) > 4.5) continue;   // tầm đặt
          if (eye.distanceTo(new Vec3(bx + 0.5, top + 2, bz + 0.5)) > HIT_REACH - 0.1) continue; // phải đập được sau khi đặt
          if (this.entityNear(bx + 0.5, top + 1, bz + 0.5)) continue;
          const self = this.selfDamage(standPos), tgt = this.targetDamage(target, standPos);
          if (self > maxSelf || tgt < 4) continue;
          const score = tgt - 1.5 * self - (kind === 'new' ? 2 : 0);
          if (score > bestScore) { bestScore = score; best = { kind, block: base }; }
        }
      }
    }
    return best;
  }
}

module.exports = { Pvp };
