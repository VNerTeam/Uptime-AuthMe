'use strict';
/**
 * Xử lý hộp thoại (Dialog) của Minecraft 1.21.6+ mà AuthMe 6.x dùng để đăng nhập/đăng ký.
 * Đầu vào: dữ liệu hộp thoại đã "simplify" (object JS thường) + mật khẩu.
 * Đầu ra: { type:'packet', id, nbt, desc } | { type:'command', command, desc } | { type:'none', reason }
 */
const nbt = require('prismarine-nbt');

const strip = (t) => String(t || '').replace(/^minecraft:/, '');

// Biến thành phần chat (chuỗi / {text, translate, extra, with} / mảng) thành chữ thường
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
  return s.replace(/§./g, '');
}

// Object JS thường -> NBT (dùng cho payload tĩnh của action "custom")
function toNbt(v) {
  if (typeof v === 'string') return nbt.string(v);
  if (typeof v === 'boolean') return nbt.byte(v ? 1 : 0);
  if (typeof v === 'number') return Number.isInteger(v) ? nbt.int(v) : nbt.double(v);
  if (Array.isArray(v)) {
    if (!v.length) return nbt.list(nbt.string([]));
    const first = toNbt(v[0]);
    return nbt.list({ type: first.type, value: v.map(x => toNbt(x).value) });
  }
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) o[k] = toNbt(v[k]);
    return nbt.comp(o);
  }
  return nbt.string('');
}

function collectButtons(d) {
  const out = [];
  const add = (b, role) => { if (b && typeof b === 'object') out.push({ label: flat(b.label), action: b.action || null, role }); };
  add(d.yes, 'yes');
  add(d.no, 'no');
  if (Array.isArray(d.actions)) d.actions.forEach(b => add(b, 'action'));
  if (d.action && !d.actions) add(d.action.label !== undefined ? d.action : { label: 'OK', action: d.action }, 'yes'); // notice
  add(d.exit_action, 'exit');
  return out;
}

const POS = /login|log in|register|đăng nhập|đăng ký|dang nhap|dang ky|xác nhận|xac nhan|confirm|submit|\bok\b|\byes\b|đồng ý|tiếp tục|continue/i;
const NEG = /cancel|hủy|huỷ|\bno\b|forgot|quên|recover|e-?mail|khôi phục|exit|close|thoát|quit/i;

function score(b) {
  const a = b.action || {};
  const hay = `${b.label} ${a.id || ''} ${a.template || ''} ${a.command || ''}`;
  let s = 0;
  if (b.role === 'yes') s += 5;
  if (b.role === 'no' || b.role === 'exit') s -= 5;
  if (POS.test(hay)) s += 10;
  if (NEG.test(hay)) s -= 20;
  if (!a.type) s -= 8; // nút không có hành động (chỉ đóng hộp thoại)
  return s;
}

// Điền giá trị cho các ô nhập
function fillInputs(inputs, password) {
  const values = {}; // key -> { v: giá trị JS, nbt: NBT }
  for (const inp of inputs || []) {
    if (!inp || !inp.key) continue;
    const type = strip(inp.type);
    const hint = `${inp.key} ${flat(inp.label)}`;
    if (type === 'text') {
      const v = /mail/i.test(hint) ? String(inp.initial || '') : password;
      values[inp.key] = { v, nbt: nbt.string(v) };
    } else if (type === 'boolean') {
      const on = inp.initial === 1 || inp.initial === true;
      values[inp.key] = { v: on, nbt: nbt.byte(on ? 1 : 0) };
    } else if (type === 'single_option') {
      const opts = Array.isArray(inp.options) ? inp.options : [];
      const pick = opts.find(o => o && o.initial) || opts[0];
      const id = pick ? String(pick.id !== undefined ? pick.id : pick) : '';
      values[inp.key] = { v: id, nbt: nbt.string(id) };
    } else if (type === 'number_range') {
      const n = Number(inp.initial !== undefined ? inp.initial : inp.start || 0);
      values[inp.key] = { v: n, nbt: nbt.float(n) };
    }
  }
  return values;
}

function planDialog(d, password) {
  if (!d || typeof d !== 'object') return { type: 'none', reason: 'dữ liệu hộp thoại trống' };
  const buttons = collectButtons(d);
  if (!buttons.length) return { type: 'none', reason: 'hộp thoại không có nút nào' };
  buttons.sort((x, y) => score(y) - score(x));
  const btn = buttons[0];
  const act = btn.action;
  if (!act || !act.type) return { type: 'none', reason: `nút "${btn.label}" không có hành động` };

  const kind = strip(act.type);
  const values = fillInputs(d.inputs, password);
  const label = btn.label || '(không tên)';

  if (kind === 'dynamic/custom') {
    const payload = {};
    if (act.additions && typeof act.additions === 'object') Object.assign(payload, toNbt(act.additions).value);
    for (const k of Object.keys(values)) payload[k] = values[k].nbt;
    return { type: 'packet', id: act.id, nbt: nbt.comp(payload), desc: `bấm "${label}" (custom ${act.id})` };
  }
  if (kind === 'custom') {
    const payload = act.payload !== undefined ? toNbt(act.payload) : undefined;
    return { type: 'packet', id: act.id, nbt: payload, desc: `bấm "${label}" (custom ${act.id})` };
  }
  if (kind === 'dynamic/run_command') {
    const cmd = String(act.template || '').replace(/\$\(([^)]+)\)/g, (_, k) => (values[k] ? String(values[k].v) : ''));
    return { type: 'command', command: cmd.replace(/^\//, ''), desc: `bấm "${label}" (chạy lệnh /${String(act.template || '').split(' ')[0]} ****)` };
  }
  if (kind === 'run_command') {
    return { type: 'command', command: String(act.command || '').replace(/^\//, ''), desc: `bấm "${label}" (chạy lệnh)` };
  }
  return { type: 'none', reason: `nút "${label}" thuộc loại hành động chưa hỗ trợ: ${kind}` };
}

module.exports = { planDialog, flat };
