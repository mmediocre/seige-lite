// Binary LAN protocol (DataView/ArrayBuffer, never JSON on the wire).
// Shared by browser client + node server. All numbers little-endian.
//
// SNAP layout: [type u8][tick u32][phase u8][phaseT f32][round u8][atkW u8]
//   [defW u8][site u8][nEnt u8][ack u16][secureT f32][slots 5u8][slotHp 5u8][ents...]
//   slot: 0 open, 1 reinforced, 2 breached. entity (13B) as below.
export const enum Msg {
  Hello = 0x01, Input = 0x02, Act = 0x03, Fire = 0x04, Ping = 0x05,
  Snap = 0x10, Hit = 0x11, Boom = 0x12, Round = 0x13, Lobby = 0x14,
  Pong = 0x15, Ammo = 0x16, Feed = 0x17, Welcome = 0x18, Chat = 0x19,
}

export const BTN = { fwd: 1, back: 2, left: 4, right: 8, sprint: 16, crouch: 32, jump: 64, fire: 128 } as const;
export const ACT = {
  reload: 0,
  usePri: 1, useSec: 2,          // hold primary/secondary (anytime)
  setPri0: 3, setPri1: 4, setPri2: 5, // pick primary ar/smg/shotgun (breaks only)
  nade: 6, start: 7, team: 8, interact: 9, interactEnd: 10,
  setSec0: 11, setSec1: 12,      // pick secondary pistol/machinepistol (breaks only)
  setBest: 13, setPrep: 14, setLock: 15, setStay: 16, // host lobby settings (value byte)
  movePlayer: 17,                // host moves a player (value = player id)
  setMap: 18,                    // host picks map (value = map idx, lobby only)
} as const;
export const GUNIDS = ['ar', 'smg', 'shotgun', 'pistol', 'machinepistol'] as const;

export interface InputMsg { seq: number; yaw: number; pitch: number; btn: number; ads: number }
export interface FireMsg { seq: number; tick: number; yaw: number; pitch: number; gun: number }
export interface EntSnap {
  id: number; x: number; y: number; z: number; yaw: number;
  hp: number; alive: boolean; crouch: boolean; side: number; gun: number;
}
export interface SnapMsg {
  tick: number; phase: number; phaseT: number; round: number;
  atkWins: number; defWins: number; teamSite: number; secureT: number;
  ack: number; slots: number[]; slotHp: number[]; ents: EntSnap[];
}
export interface HitMsg { shooter: number; victim: number; dmg: number; head: boolean; kill: boolean }
export interface LobbyPlayer { id: number; name: string; side: number; host: boolean }

const enc = new TextEncoder();
const dec = new TextDecoder();
const qpos = (f: number) => Math.max(-32768, Math.min(32767, Math.round(f * 64)));
const qyaw = (f: number) => Math.max(-32768, Math.min(32767, Math.round(f * 1000)));

// ---- client -> server ----
export function encHello(name: string, side: number, gun: number): ArrayBuffer {
  const nb = enc.encode(name.slice(0, 16));
  const b = new ArrayBuffer(4 + nb.length);
  const v = new DataView(b);
  v.setUint8(0, Msg.Hello);
  v.setUint8(1, nb.length);
  new Uint8Array(b).set(nb, 2);
  v.setUint8(2 + nb.length, side);
  v.setUint8(3 + nb.length, gun);
  return b;
}

export function decHello(buf: ArrayBuffer): { name: string; side: number; gun: number } {
  const v = new DataView(buf);
  const n = v.getUint8(1);
  return { name: dec.decode(new Uint8Array(buf, 2, n)), side: v.getUint8(2 + n), gun: v.getUint8(3 + n) };
}

export function encInput(m: InputMsg): ArrayBuffer {
  const b = new ArrayBuffer(13);
  const v = new DataView(b);
  v.setUint8(0, Msg.Input);
  v.setUint16(1, m.seq, true);
  v.setFloat32(3, m.yaw, true);
  v.setFloat32(7, m.pitch, true);
  v.setUint8(11, m.btn);
  v.setUint8(12, m.ads);
  return b;
}

export function decInput(buf: ArrayBuffer): InputMsg {
  const v = new DataView(buf);
  return {
    seq: v.getUint16(1, true), yaw: v.getFloat32(3, true), pitch: v.getFloat32(7, true),
    btn: v.getUint8(11), ads: buf.byteLength > 12 ? v.getUint8(12) : 0,
  };
}

export function encAct(seq: number, code: number, value = 0): ArrayBuffer {
  const b = new ArrayBuffer(5);
  const v = new DataView(b);
  v.setUint8(0, Msg.Act);
  v.setUint16(1, seq, true);
  v.setUint8(3, code);
  v.setUint8(4, value);
  return b;
}

export function decAct(buf: ArrayBuffer): { seq: number; code: number; value: number } {
  const v = new DataView(buf);
  return {
    seq: v.getUint16(1, true), code: v.getUint8(3),
    value: buf.byteLength > 4 ? v.getUint8(4) : 0,
  };
}

export function encFire(m: FireMsg): ArrayBuffer {
  const b = new ArrayBuffer(16);
  const v = new DataView(b);
  v.setUint8(0, Msg.Fire);
  v.setUint16(1, m.seq, true);
  v.setUint32(3, m.tick, true);
  v.setFloat32(7, m.yaw, true);
  v.setFloat32(11, m.pitch, true);
  v.setUint8(15, m.gun);
  return b;
}

export function decFire(buf: ArrayBuffer): FireMsg {
  const v = new DataView(buf);
  return { seq: v.getUint16(1, true), tick: v.getUint32(3, true), yaw: v.getFloat32(7, true), pitch: v.getFloat32(11, true), gun: v.getUint8(15) };
}

export function encPing(t: number): ArrayBuffer {
  const b = new ArrayBuffer(5);
  const v = new DataView(b);
  v.setUint8(0, Msg.Ping);
  v.setUint32(1, t, true);
  return b;
}

// ---- server -> client ----
export function encSnap(m: SnapMsg): ArrayBuffer {
  const b = new ArrayBuffer(31 + m.ents.length * 13);
  const v = new DataView(b);
  v.setUint8(0, Msg.Snap);
  v.setUint32(1, m.tick, true);
  v.setUint8(5, m.phase);
  v.setFloat32(6, m.phaseT, true);
  v.setUint8(10, m.round);
  v.setUint8(11, m.atkWins);
  v.setUint8(12, m.defWins);
  v.setUint8(13, m.teamSite);
  v.setUint8(14, m.ents.length);
  v.setUint16(15, m.ack, true);
  v.setFloat32(17, m.secureT, true);
  for (let i = 0; i < 5; i++) v.setUint8(21 + i, m.slots[i] ?? 0);
  for (let i = 0; i < 5; i++) v.setUint8(26 + i, m.slotHp[i] ?? 0);
  let o = 31;
  for (const e of m.ents) {
    v.setUint8(o, e.id);
    v.setInt16(o + 1, qpos(e.x), true);
    v.setInt16(o + 3, qpos(e.y), true);
    v.setInt16(o + 5, qpos(e.z), true);
    v.setInt16(o + 7, qyaw(e.yaw), true);
    v.setUint16(o + 9, e.hp, true);
    v.setUint8(o + 11, (e.alive ? 1 : 0) | (e.crouch ? 2 : 0));
    v.setUint8(o + 12, (e.side & 1) | ((e.gun & 7) << 1));
    o += 13;
  }
  return b;
}

export function decSnap(buf: ArrayBuffer, out: EntSnap[]): SnapMsg {
  const v = new DataView(buf);
  const n = v.getUint8(14);
  out.length = 0;
  const slots: number[] = [];
  for (let i = 0; i < 5; i++) slots.push(v.getUint8(21 + i));
  const slotHp: number[] = [];
  for (let i = 0; i < 5; i++) slotHp.push(v.getUint8(26 + i));
  let o = 31;
  for (let i = 0; i < n; i++) {
    const flags = v.getUint8(o + 11);
    const sg = v.getUint8(o + 12);
    out.push({
      id: v.getUint8(o),
      x: v.getInt16(o + 1, true) / 64,
      y: v.getInt16(o + 3, true) / 64,
      z: v.getInt16(o + 5, true) / 64,
      yaw: v.getInt16(o + 7, true) / 1000,
      hp: v.getUint16(o + 9, true),
      alive: (flags & 1) !== 0,
      crouch: (flags & 2) !== 0,
      side: sg & 1,
      gun: (sg >> 1) & 7,
    });
    o += 13;
  }
  return {
    tick: v.getUint32(1, true), phase: v.getUint8(5), phaseT: v.getFloat32(6, true),
    round: v.getUint8(10), atkWins: v.getUint8(11), defWins: v.getUint8(12),
    teamSite: v.getUint8(13), ack: v.getUint16(15, true), secureT: v.getFloat32(17, true),
    slots, slotHp, ents: out,
  };
}

export function encHit(m: HitMsg): ArrayBuffer {
  const b = new ArrayBuffer(5);
  const v = new DataView(b);
  v.setUint8(0, Msg.Hit);
  v.setUint8(1, m.shooter);
  v.setUint8(2, m.victim);
  v.setUint8(3, m.dmg > 255 ? 255 : m.dmg);
  v.setUint8(4, (m.head ? 1 : 0) | (m.kill ? 2 : 0));
  return b;
}

export function decHit(buf: ArrayBuffer): HitMsg {
  const v = new DataView(buf);
  const f = v.getUint8(4);
  return { shooter: v.getUint8(1), victim: v.getUint8(2), dmg: v.getUint8(3), head: (f & 1) !== 0, kill: (f & 2) !== 0 };
}

export function encBoom(x: number, y: number, z: number): ArrayBuffer {
  const b = new ArrayBuffer(13);
  const v = new DataView(b);
  v.setUint8(0, Msg.Boom);
  v.setFloat32(1, x, true);
  v.setFloat32(5, y, true);
  v.setFloat32(9, z, true);
  return b;
}

export function decBoom(buf: ArrayBuffer): { x: number; y: number; z: number } {
  const v = new DataView(buf);
  return { x: v.getFloat32(1, true), y: v.getFloat32(5, true), z: v.getFloat32(9, true) };
}

export function encRound(code: number, aux: number): ArrayBuffer {
  const b = new ArrayBuffer(3);
  const v = new DataView(b);
  v.setUint8(0, Msg.Round);
  v.setUint8(1, code);
  v.setUint8(2, aux);
  return b;
}

export interface LobbySettings { bestOf: number; prepS: number; lock: boolean; stay: boolean; map: number }
export const DEFAULT_LOBBY_SETTINGS: LobbySettings = { bestOf: 5, prepS: 10, lock: false, stay: true, map: 0 };

export function encLobby(players: LobbyPlayer[], s: LobbySettings = DEFAULT_LOBBY_SETTINGS): ArrayBuffer {
  const names = players.map((p) => enc.encode(p.name.slice(0, 16)));
  let len = 2;
  for (const n of names) len += 4 + n.length;
  const b = new ArrayBuffer(len + 5);
  const v = new DataView(b);
  v.setUint8(0, Msg.Lobby);
  v.setUint8(1, players.length);
  let o = 2;
  players.forEach((p, i) => {
    v.setUint8(o, p.id);
    v.setUint8(o + 1, p.side);
    v.setUint8(o + 2, p.host ? 1 : 0);
    v.setUint8(o + 3, names[i].length);
    new Uint8Array(b).set(names[i], o + 4);
    o += 4 + names[i].length;
  });
  v.setUint8(o, s.bestOf);
  v.setUint8(o + 1, s.prepS);
  v.setUint8(o + 2, s.lock ? 1 : 0);
  v.setUint8(o + 3, s.stay ? 1 : 0);
  v.setUint8(o + 4, s.map);
  return b;
}

export function decLobby(buf: ArrayBuffer): { players: LobbyPlayer[]; settings: LobbySettings } {
  const v = new DataView(buf);
  const n = v.getUint8(1);
  const players: LobbyPlayer[] = [];
  let o = 2;
  for (let i = 0; i < n; i++) {
    const nl = v.getUint8(o + 3);
    players.push({
      id: v.getUint8(o), side: v.getUint8(o + 1), host: v.getUint8(o + 2) !== 0,
      name: dec.decode(new Uint8Array(buf, o + 4, nl)),
    });
    o += 4 + nl;
  }
  const hasSettings = o + 5 <= buf.byteLength;
  return {
    players,
    settings: hasSettings
      ? { bestOf: v.getUint8(o), prepS: v.getUint8(o + 1), lock: v.getUint8(o + 2) !== 0, stay: v.getUint8(o + 3) !== 0, map: v.getUint8(o + 4) }
      : { ...DEFAULT_LOBBY_SETTINGS },
  };
}

export function encAmmo(mag: number, nades: number, reloading: number): ArrayBuffer {
  const b = new ArrayBuffer(4);
  const v = new DataView(b);
  v.setUint8(0, Msg.Ammo);
  v.setUint8(1, mag);
  v.setUint8(2, nades);
  v.setUint8(3, reloading);
  return b;
}

export function encFeed(text: string): ArrayBuffer {
  const tb = enc.encode(text.slice(0, 64));
  const b = new ArrayBuffer(2 + tb.length);
  const v = new DataView(b);
  v.setUint8(0, Msg.Feed);
  v.setUint8(1, tb.length);
  new Uint8Array(b).set(tb, 2);
  return b;
}

export function decFeed(buf: ArrayBuffer): string {
  const v = new DataView(buf);
  return dec.decode(new Uint8Array(buf, 2, v.getUint8(1)));
}

// All-chat: [type][sender u8][len u8][text…] (text ≤ 64 chars, server enforced)
export function encChat(sender: number, text: string): ArrayBuffer {
  const tb = enc.encode(text.slice(0, 64));
  const b = new ArrayBuffer(3 + tb.length);
  const v = new DataView(b);
  v.setUint8(0, Msg.Chat);
  v.setUint8(1, sender);
  v.setUint8(2, tb.length);
  new Uint8Array(b).set(tb, 3);
  return b;
}

export function decChat(buf: ArrayBuffer): { sender: number; text: string } {
  const v = new DataView(buf);
  const n = v.getUint8(2);
  return { sender: v.getUint8(1), text: dec.decode(new Uint8Array(buf, 3, n)) };
}

// Your assigned id + final (unique) name. Trust this, not name matching.
export function encWelcome(id: number, name: string): ArrayBuffer {
  const nb = enc.encode(name.slice(0, 16));
  const b = new ArrayBuffer(3 + nb.length);
  const v = new DataView(b);
  v.setUint8(0, Msg.Welcome);
  v.setUint8(1, id);
  v.setUint8(2, nb.length);
  new Uint8Array(b).set(nb, 3);
  return b;
}

export function decWelcome(buf: ArrayBuffer): { id: number; name: string } {
  const v = new DataView(buf);
  const n = v.getUint8(2);
  return { id: v.getUint8(1), name: dec.decode(new Uint8Array(buf, 3, n)) };
}
