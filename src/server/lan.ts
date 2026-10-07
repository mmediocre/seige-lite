// M5: authoritative LAN server (30Hz) + static file host + lobby.
// Run: npm run host  (builds client, bundles this, serves ./dist + ws)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CFG } from '../shared/config.js';
import { buildGrid, raycast, type Collider, type Grid } from '../shared/colliders.js';
import { makePlayer, stepPlayer, type Player } from '../shared/sim.js';
import { fireHitscan, hurt, makePelletPool, type ShootEnt } from '../shared/combat.js';
import { blastDamage, makeNade, stepNade, throwNade, type Nade } from '../shared/grenade.js';
import { makeMatch, updateMatch, type Match } from '../shared/rounds.js';
import { History, type HistEnt } from '../shared/history.js';
import { MAP_FILES } from '../shared/maps.js';
import { damageSlot, makeSlots, resetSlots, slotAtPoint, stepBreach, tryReinforce, type Slot } from '../shared/destruct.js';
import { WEAPONS } from '../shared/weapons.js';
import { findMarker, hasTag, splitScene } from '../client/mapLoader.js';
import {
  ACT, BTN, GUNIDS, Msg, decChat, decFire, decHello, decInput,
  encAmmo, encBoom, encChat, encFeed, encHit, encLobby, encRound, encSnap, encWelcome,
  type EntSnap,
} from '../shared/net.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = (globalThis as unknown as { __DIST?: string }).__DIST || path.join(root, '..', 'dist');
const PORT = Number(process.env.PORT || 3000);
const TICK = 1 / 30;

// ---------- maps (all three preload, host picks) ----------
interface MapSet {
  baseColliders: Collider[];
  selfNames: Set<string>;
  markers: Record<string, THREE.Vector3>;
  slotBoxes: { name: string; kind: 'wall' | 'hatch'; min: number[]; max: number[] }[];
}
const maps: MapSet[] = [];
for (const f of MAP_FILES) {
  const glb = fs.readFileSync(path.join(dist, f));
  const buf: ArrayBuffer = glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer;
  const parsed: { scene: THREE.Object3D } = await new Promise((res, rej) => {
    new GLTFLoader().parse(buf, '', res as never, rej);
  });
  // NOTE: this file bundles to ESM (see build-server), so top-level await is fine.
  const md = splitScene(parsed.scene);
  const self = new Set(md.slotBoxes.map((s) => s.name));
  maps.push({
    baseColliders: md.colliders, selfNames: self,
    markers: md.markers, slotBoxes: md.slotBoxes,
  });
  console.log(`map ${f}: ${md.colliders.length} colliders, ${md.slotBoxes.length} slots`);
}
// live playfield (points at the active map, rebuilt on switch/change)
let playColliders: Collider[] = [];
let grid: Grid = buildGrid([]);
let markers: Record<string, THREE.Vector3> = {};
let serverSlots: Slot[] = [];
let activeMap = 0;
function useMap(idx: number): void {
  const m = maps[idx] ?? maps[0];
  activeMap = maps.indexOf(m);
  playColliders = m.baseColliders.filter((c) => !m.selfNames.has(c.name));
  grid = buildGrid(playColliders);
  markers = m.markers;
  serverSlots = makeSlots(m.slotBoxes);
  siteCache = Object.keys(markers).filter((k) => hasTag(k, 'Objective_')).sort().map((k) => markers[k]);
}
useMap(0); // lobby default until the host picks

function applySlotServer(i: number): void {
  const s = serverSlots[i];
  for (let k = playColliders.length - 1; k >= 0; k--) {
    if (playColliders[k].name === s.name) playColliders.splice(k, 1);
  }
  if (s.state === 'reinforced') {
    playColliders.push({
      kind: 'box', name: s.name, group: 'wall',
      minX: s.minX, minY: s.minY, minZ: s.minZ,
      maxX: s.maxX, maxY: s.maxY, maxZ: s.maxZ,
    });
  }
  grid = buildGrid(playColliders);
}

function resetSlotsServer(): void {
  resetSlots(serverSlots);
  const m = maps[activeMap] ?? maps[0];
  playColliders = m.baseColliders.filter((c) => !m.selfNames.has(c.name));
  grid = buildGrid(playColliders);
}

// ---------- players ----------
interface P {
  id: number; slot: number; ws: WebSocket; name: string;
  side: 0 | 1; gun: number; pri: number; sec: number;
  sim: Player; yaw: number; pitch: number;
  hp: number; alive: boolean;
  mag: number; nades: number; reloadT: number; shotT: number;
  seq: number; btn: number; ads: boolean;
  interacting: boolean;
  lastReinf: number;
  lastChat: number;
  lastInputAt: number; kills: number;
  nadeSt: Nade[];
}
const players = new Map<WebSocket, P>();
const order: P[] = []; // tick order, rebuilt on join/leave (no per-tick alloc)
function syncOrder(): void {
  order.length = 0;
  for (const p of players.values()) order.push(p);
  order.forEach((p, i) => { p.slot = i; });
}
let nextId = 0;
let host: WebSocket | null = null;
// host-tunable lobby settings (sent to everyone, applied on match start)
const settings = { bestOf: 5, prepS: 10, lock: false, stay: true, map: 0 };

function roundCfg() {
  return {
    prepS: settings.prepS,
    actionS: CFG.actionS,
    secureTime: CFG.secureTime,
    maxRounds: settings.bestOf,
    winRounds: Math.floor(settings.bestOf / 2) + 1,
    swapAfterRound: Math.floor(settings.bestOf / 2),
  };
}
// preallocated per-tick scratch (10 players max)
const nadeVictims = Array.from({ length: 10 }, () => ({ x: 0, y: 0, z: 0 }));
const nadeOut = Array.from({ length: 10 }, () => ({ i: 0, dmg: 0 }));
const slotStates = [0, 0, 0, 0, 0];
const slotHp = [0, 0, 0, 0, 0];
const snapEnts: EntSnap[] = Array.from({ length: 10 }, () => (
  { id: 0, x: 0, y: 0, z: 0, yaw: 0, hp: 100, alive: false, crouch: false, side: 0, gun: 0 }
));

function gunDef(i: number) { return WEAPONS[GUNIDS[i] ?? 'ar']; }

function siteList(): THREE.Vector3[] {
  return siteCache;
}
let siteCache: THREE.Vector3[] = [];

function activeSite(): THREE.Vector3 {
  return siteCache[match.teamSite] ?? siteCache[0] ?? { x: 0, y: 0, z: 0 } as THREE.Vector3;
}

function spawnFor(p: P, slot: number): void {
  const atk = ['Spawn_Attacker_1', 'Spawn_Attacker_2', 'Spawn_Attacker_3']
    .map((n) => findMarker(markers, n));
  if (p.side === 0) {
    const m = atk[slot % 3] ?? atk[0];
    if (!m) return;
    p.sim.x = m.x; p.sim.y = m.y + 0.1; p.sim.z = m.z;
    p.yaw = 0;
  } else {
    // defenders spawn ON the active site, spread around it
    const s = activeSite();
    const off = [[1.5, 1.5], [-1.5, 1.5], [0, -2.5], [2.5, -1], [-2.5, -1]][slot % 5];
    p.sim.x = s.x + off[0]; p.sim.y = s.y + 0.1; p.sim.z = s.z + off[1];
    p.yaw = Math.PI;
  }
  p.sim.vx = p.sim.vy = p.sim.vz = 0;
  p.hp = CFG.playerHp; p.alive = true;
  p.mag = WEAPONS[GUNIDS[p.gun]].mag;
  p.nades = 2; p.reloadT = 0; p.interacting = false;
  for (const n of p.nadeSt) n.active = false;
}

// ---------- match ----------
type PhaseName = 'lobby' | 'prep' | 'action' | 'roundEnd' | 'matchEnd';
let phase: PhaseName = 'lobby';
let match: Match = makeMatch('atk', Math.random);
let tick = 0;
const hist = new History(64, 10);
const histEnts: HistEnt[] = [];
for (let i = 0; i < 10; i++) histEnts.push({ x: 0, y: 0, z: 0, crouch: false, alive: false });
const pellets = makePelletPool(8);
const shootEnts: ShootEnt[] = [];
for (let i = 0; i < 10; i++) shootEnts.push({ x: 0, y: 0, z: 0, crouch: false, alive: false, side: 'atk' });

function sideCount(side: 0 | 1): number {
  let n = 0;
  for (const p of players.values()) if (p.side === side) n++;
  return n;
}

function broadcast(buf: ArrayBuffer): void {
  for (const p of players.values()) {
    if (p.ws.readyState === WebSocket.OPEN) p.ws.send(buf);
  }
}

function sendLobby(): void {
  const list = [...players.values()].map((p) => ({ id: p.id, name: p.name, side: p.side, host: p.ws === host }));
  broadcast(encLobby(list, { bestOf: settings.bestOf, prepS: settings.prepS, lock: settings.lock, stay: settings.stay, map: settings.map }));
}

function startMatch(): void {
  useMap(settings.map);
  match = makeMatch('atk', Math.random, roundCfg(), siteCache.length);
  tick = 0;
  resetSlotsServer();
  hist.clear();
  let ai = 0, di = 0;
  for (const p of players.values()) {
    spawnFor(p, p.side === 0 ? ai++ : di++);
  }
  phase = 'prep';
  broadcast(encRound(0, 1));
  console.log(`match started with ${players.size} players`);
}

function resetRoundPositions(): void {
  resetSlotsServer();
  let ai = 0, di = 0;
  for (const p of players.values()) spawnFor(p, p.side === 0 ? ai++ : di++);
}

// ---------- shooting (lag compensated) ----------
function onFire(p: P, f: { tick: number; yaw: number; pitch: number; gun: number }): void {
  if (phase !== 'action' || !p.alive) return;
  const def = gunDef(p.gun);
  if (p.shotT > 0 || p.reloadT > 0 || p.mag <= 0) return;
  p.mag--;
  p.shotT = 60 / def.rpm;
  sendAmmo(p);
  // rewind everyone to the shooter's view tick, then shoot
  hist.at(f.tick, histEnts);
  for (let i = 0; i < order.length; i++) {
    const s = shootEnts[i];
    s.x = histEnts[i].x; s.y = histEnts[i].y; s.z = histEnts[i].z;
    s.crouch = histEnts[i].crouch; s.alive = histEnts[i].alive;
    s.side = order[i].side === 0 ? 'atk' : 'def';
  }
  for (let i = order.length; i < shootEnts.length; i++) shootEnts[i].alive = false;
  const cp = Math.cos(f.pitch);
  const dx = -Math.sin(f.yaw) * cp, dy = Math.sin(f.pitch), dz = -Math.cos(f.yaw) * cp;
  const ox = shootEnts[p.slot].x;
  const oy = shootEnts[p.slot].y + 1.55;
  const oz = shootEnts[p.slot].z;
  const n = fireHitscan(ox, oy, oz, dx, dy, dz, def, Math.random,
    (x, y, z, ax, ay, az, m) => raycast(playColliders, x, y, z, ax, ay, az, m),
    [], pellets, 1, shootEnts, p.side === 0 ? 'atk' : 'def');
  for (let k = 0; k < n; k++) {
    const h = pellets[k];
    if (h.ent >= 0 && h.ent < order.length) {
      const victim = order[h.ent];
      if (victim && victim.alive) {
        const [hp, alive] = hurt(victim.hp, h.dmg);
        victim.hp = hp;
        const killed = !alive;
        if (killed) { victim.alive = false; p.kills++; }
        sendAmmo(victim);
        broadcast(encHit({ shooter: p.id, victim: victim.id, dmg: Math.round(h.dmg), head: h.head, kill: killed }));
      }
    } else if (h.ent < 0 && h.dist < 100) {
      // bullets chip reinforced walls too
      const at = slotAtPoint(serverSlots, h.px, h.py, h.pz);
      if (at) {
        const broke = damageSlot(serverSlots, at.name, h.dmg);
        if (broke) {
          applySlotServer(serverSlots.indexOf(broke));
          broadcast(encFeed(`${p.name} shot open ${broke.name}!`));
        }
      }
    }
  }
}

function sendAmmo(p: P): void {
  if (p.ws.readyState === WebSocket.OPEN) {
    p.ws.send(encAmmo(p.mag, p.nades, p.reloadT > 0 ? 1 : 0));
  }
}

// ---------- tick ----------
const DT = TICK;
function serverTick(): void {
  tick++;
  if (phase === 'lobby') {
    if (players.size === 0) { /* idle */ }
    return;
  }
  // move
  for (const p of players.values()) {
    if (!p.alive) continue;
    if (phase === 'prep' && p.side === 0) continue; // attackers frozen
    if (phase !== 'prep' && phase !== 'action') continue;
    const b = p.btn;
    stepPlayer(p.sim, {
      fwd: (b & BTN.fwd) !== 0, back: (b & BTN.back) !== 0,
      left: (b & BTN.left) !== 0, right: (b & BTN.right) !== 0,
      sprint: (b & BTN.sprint) !== 0, crouch: (b & BTN.crouch) !== 0,
      jump: (b & BTN.jump) !== 0, yaw: p.yaw,
    }, DT, playColliders, grid, 1);
    if (p.shotT > 0) p.shotT -= DT;
    if (p.reloadT > 0) {
      p.reloadT -= DT;
      if (p.reloadT <= 0) { p.mag = gunDef(p.gun).mag; sendAmmo(p); }
    }
    // F interact: reinforce (def/prep+action, 1s cooldown) + breach (atk/action, hold)
    if (p.interacting) {
      const side = p.side === 0 ? 'atk' : 'def';
      const ph = phase === 'prep' ? 'prep' : 'action';
      const now = Date.now();
      if (now - p.lastReinf >= 1000) {
        const made = tryReinforce(serverSlots, side, ph, p.sim.x, p.sim.y, p.sim.z);
        if (made) {
          p.lastReinf = now;
          applySlotServer(serverSlots.indexOf(made));
          broadcast(encFeed(`${p.name} reinforced`));
        }
      }
      const boom = stepBreach(serverSlots, side, ph, true, p.sim.x, p.sim.y, p.sim.z, DT);
      if (boom) {
        applySlotServer(serverSlots.indexOf(boom));
        broadcast(encFeed(`${p.name} breached!`));
      }
    } else {
      const side = p.side === 0 ? 'atk' : 'def';
      const ph = phase === 'prep' ? 'prep' : 'action';
      stepBreach(serverSlots, side, ph, false, p.sim.x, p.sim.y, p.sim.z, DT);
    }
    // nades
    for (const nd of p.nadeSt) {
      if (!nd.active) continue;
      if (stepNade(nd, DT, playColliders, grid)) {
        broadcast(encBoom(nd.x, nd.y, nd.z));
        // hurt entities in radius
        for (let i = 0; i < order.length; i++) {
          nadeVictims[i].x = order[i].sim.x;
          nadeVictims[i].y = order[i].sim.y + 0.9;
          nadeVictims[i].z = order[i].sim.z;
        }
        const nn = blastDamage(nd.x, nd.y, nd.z, nadeVictims, playColliders, nadeOut);
        for (let k = 0; k < nn; k++) {
          const v = order[nadeOut[k].i];
          if (!v || !v.alive) continue;
          const [hp, alive] = hurt(v.hp, nadeOut[k].dmg);
          v.hp = hp;
          const killed = !alive;
          if (killed) { v.alive = false; p.kills++; }
          sendAmmo(v);
          broadcast(encHit({ shooter: p.id, victim: v.id, dmg: nadeOut[k].dmg, head: false, kill: killed }));
        }
      }
    }
  }
  // rounds
  let atkAlive = 0, defAlive = 0, atkIn = 0, defIn = 0;
  const site = activeSite();
  for (const p of players.values()) {
    if (!p.alive) continue;
    if (p.side === 0) atkAlive++; else defAlive++;
    const dx = p.sim.x - site.x, dz = p.sim.z - site.z;
    if (dx * dx + dz * dz < CFG.secureRadius * CFG.secureRadius && Math.abs(p.sim.y - site.y) < 1.5) {
      if (p.side === 0) atkIn++; else defIn++;
    }
  }
  updateMatch(match, 'atk', Math.random, DT, atkAlive, defAlive, atkIn, defIn, roundCfg());
  phase = match.phase as PhaseName;
  for (const ev of match.events) {
    if (ev === 'roundStart') { resetRoundPositions(); broadcast(encRound(0, match.round)); }
    else if (ev === 'actionStart') broadcast(encRound(1, 0));
    else if (ev.startsWith('atkWin')) broadcast(encRound(2, 0));
    else if (ev.startsWith('defWin')) broadcast(encRound(3, 0));
    else if (ev === 'matchAtk') broadcast(encRound(4, match.atkWins));
    else if (ev === 'matchDef') broadcast(encRound(5, match.defWins));
  }
  match.events.length = 0;
  // history (mark unused slots dead so leavers don't haunt lag comp)
  for (let i = 0; i < order.length && i < 10; i++) {
    histEnts[i].x = order[i].sim.x; histEnts[i].y = order[i].sim.y; histEnts[i].z = order[i].sim.z;
    histEnts[i].crouch = order[i].sim.crouching; histEnts[i].alive = order[i].alive;
  }
  for (let i = order.length; i < 10; i++) histEnts[i].alive = false;
  hist.record(tick, histEnts);
  // snapshot (pooled ents, no per-tick alloc)
  for (let i = 0; i < order.length; i++) {
    const p = order[i], e = snapEnts[i];
    e.id = p.id; e.x = p.sim.x; e.y = p.sim.y; e.z = p.sim.z; e.yaw = p.yaw;
    e.hp = p.hp; e.alive = p.alive; e.crouch = p.sim.crouching;
    e.side = p.side; e.gun = p.gun;
  }
  const phaseNum = phase === 'prep' ? 0 : phase === 'action' ? 1 : phase === 'roundEnd' ? 2 : 3;
  for (let i = 0; i < serverSlots.length; i++) {
    slotStates[i] = serverSlots[i].state === 'open' ? 0 : serverSlots[i].state === 'reinforced' ? 1 : 2;
    slotHp[i] = Math.ceil(serverSlots[i].hp);
  }
  for (const p of players.values()) {
    if (p.ws.readyState !== WebSocket.OPEN) continue;
    p.ws.send(encSnap({
      tick, phase: phaseNum, phaseT: match.t, round: match.round,
      atkWins: match.atkWins, defWins: match.defWins,
      teamSite: match.teamSite, secureT: match.secureT,
      ack: p.seq, slots: slotStates, slotHp, ents: snapEnts.slice(0, order.length),
    }));
  }
  if (players.size === 0 && phase !== 'lobby') {
    phase = 'lobby';
  }
}

// ---------- net ----------
const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.glb': 'model/gltf-binary',
  '.png': 'image/png', '.ico': 'image/x-icon',
};
const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); res.end('ok'); return; }
  let urlPath = (req.url || '/').split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';
  const file = path.join(dist, path.normalize(urlPath).replace(/^[/\\]+/, ''));
  if (!file.startsWith(dist)) { res.writeHead(403); res.end('no'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });
wss.on('connection', (ws: WebSocket) => {
  let me: P | null = null;
  ws.binaryType = 'arraybuffer';
  ws.on('message', (raw: unknown) => {
    const buf = raw as ArrayBuffer;
    const type = new DataView(buf).getUint8(0);
    if (type === Msg.Hello) {
      if (me || players.size >= 10) return;
      const h = decHello(buf);
      // unique names (clients match their lobby id by name)
      let nm = (h.name || 'Player').slice(0, 12);
      if ([...players.values()].some((q) => q.name === nm)) {
        let k = 2;
        while ([...players.values()].some((q) => q.name === `${nm}_${k}`)) k++;
        nm = `${nm}_${k}`;
      }
      const side: 0 | 1 = settings.lock
        ? (sideCount(0) <= sideCount(1) ? 0 : 1) // locked: host assigns, atk first
        : h.side === 1 && sideCount(1) < 5 ? 1 : sideCount(0) < 5 ? 0 : 1;
      me = {
        id: nextId++, slot: -1, ws, name: nm, side,
        gun: h.gun >= 0 && h.gun < 3 ? h.gun : 0,
        pri: h.gun >= 0 && h.gun < 3 ? h.gun : 0,
        sec: 3,
        sim: makePlayer(0, 0.1, -14), yaw: 0, pitch: 0,
        hp: CFG.playerHp, alive: true, mag: 30, nades: 2,
        reloadT: 0, shotT: 0, seq: 0, btn: 0, ads: false, interacting: false,
        lastReinf: 0, lastChat: 0,
        lastInputAt: 0, kills: 0, nadeSt: [makeNade(), makeNade()],
      };
      if (!host || (host as WebSocket).readyState !== WebSocket.OPEN) host = ws;
      players.set(ws, me);
      syncOrder();
      if (phase === 'lobby') { /* wait for start */ }
      else {
        // mid-match join: spawn immediately
        let ai = 0, di = 0;
        for (const q of players.values()) { if (q === me) continue; if (q.side === 0) ai++; else di++; }
        spawnFor(me, me.side === 0 ? ai : di);
      }
      sendLobby();
      sendAmmo(me);
      if (ws.readyState === WebSocket.OPEN) ws.send(encWelcome(me.id, me.name));
      broadcast(encFeed(`${me.name} joined`));
      console.log(`join ${me.name} (${players.size})`);
      return;
    }
    if (!me) return;
    if (type === Msg.Input) {
      const m = decInput(buf);
      if (!Number.isFinite(m.yaw) || !Number.isFinite(m.pitch)) return;
      if (m.seq < me.seq) return; // stale
      me.seq = m.seq;
      me.yaw = m.yaw;
      me.pitch = Math.max(-1.55, Math.min(1.55, m.pitch));
      me.btn = m.btn & 255;
      me.ads = m.ads !== 0;
      me.lastInputAt = Date.now();
    } else if (type === Msg.Act) {
      const v = new DataView(buf);
      const code = v.getUint8(3);
      if (code === ACT.start) {
        if (ws === host && (phase === 'lobby' || phase === 'matchEnd') && players.size >= 1) startMatch();
      } else if (code === ACT.reload) {
        if (me.alive && me.reloadT <= 0 && me.mag < gunDef(me.gun).mag) {
          me.reloadT = gunDef(me.gun).reloadS;
          sendAmmo(me);
        }
      } else if (code === ACT.usePri || code === ACT.useSec) {
        // hold primary/secondary (anytime while alive)
        const id = code === ACT.usePri ? me.pri : me.sec;
        if (me.alive && me.gun !== id) {
          me.gun = id;
          me.mag = gunDef(id).mag;
          me.reloadT = 0;
          sendAmmo(me);
        }
      } else if (code >= ACT.setPri0 && code <= ACT.setPri2) {
        // pick primary in a break (prep/roundEnd/matchEnd), not mid-fight
        if (phase !== 'prep' && phase !== 'roundEnd' && phase !== 'matchEnd') return;
        const gi = code - ACT.setPri0;
        if (me.alive) {
          me.pri = gi; me.gun = gi;
          me.mag = gunDef(gi).mag;
          me.reloadT = 0;
          sendAmmo(me);
        }
      } else if (code === ACT.setSec0 || code === ACT.setSec1) {
        if (phase !== 'prep' && phase !== 'roundEnd' && phase !== 'matchEnd') return;
        const gi = code === ACT.setSec0 ? 3 : 4;
        if (me.alive) {
          me.sec = gi; me.gun = gi;
          me.mag = gunDef(gi).mag;
          me.reloadT = 0;
          sendAmmo(me);
        }
      } else if (code === ACT.nade) {
        if (phase === 'action' && me.alive && me.nades > 0) {
          const nd = me.nadeSt.find((n) => !n.active);
          if (nd) {
            me.nades--;
            const cp = Math.cos(me.pitch);
            throwNade(nd, me.sim.x, me.sim.y + 1.55, me.sim.z,
              -Math.sin(me.yaw) * cp, Math.sin(me.pitch), -Math.cos(me.yaw) * cp);
            sendAmmo(me);
          }
        }
      } else if (code === ACT.interact) {
        me.interacting = true;
      } else if (code === ACT.interactEnd) {
        me.interacting = false;
      } else if (code === ACT.team) {
        if (settings.lock && ws !== host) {
          if (ws.readyState === WebSocket.OPEN) ws.send(encFeed('teams locked by host'));
          return;
        }
        const want: 0 | 1 = me.side === 0 ? 1 : 0;
        if (want === me.side) { /* already there */ }
        else if (sideCount(want) >= 5) {
          if (ws.readyState === WebSocket.OPEN) ws.send(encFeed('that team is full (5 max)'));
        } else {
          me.side = want;
          if (phase === 'lobby' || phase === 'matchEnd') {
            // applies on next start
          } else {
            // respawn now on the new side
            let n = 0;
            for (const q of players.values()) if (q !== me && q.side === want) n++;
            spawnFor(me, n);
          }
          sendLobby();
          broadcast(encFeed(`${me.name} → ${want === 0 ? 'ATTACK' : 'DEFEND'}`));
        }
      } else if (code === ACT.setBest || code === ACT.setPrep || code === ACT.setLock || code === ACT.setStay || code === ACT.setMap) {
        if (ws !== host || (phase !== 'lobby' && phase !== 'matchEnd')) return;
        const val = buf.byteLength > 4 ? v.getUint8(4) : 0;
        if (code === ACT.setBest && [1, 3, 5, 7].includes(val)) settings.bestOf = val;
        else if (code === ACT.setPrep && val >= 5 && val <= 30) settings.prepS = val;
        else if (code === ACT.setLock) settings.lock = val !== 0;
        else if (code === ACT.setStay) settings.stay = val !== 0;
        else if (code === ACT.setMap && val < maps.length) settings.map = val;
        sendLobby();
      } else if (code === ACT.movePlayer) {
        if (ws !== host) return;
        const targetId = buf.byteLength > 4 ? v.getUint8(4) : 255;
        const target = order.find((q) => q.id === targetId);
        if (!target || target === me) return;
        const want: 0 | 1 = target.side === 0 ? 1 : 0;
        if (sideCount(want) >= 5) {
          if (ws.readyState === WebSocket.OPEN) ws.send(encFeed('that team is full (5 max)'));
          return;
        }
        target.side = want;
        if (phase !== 'lobby' && phase !== 'matchEnd') {
          let n = 0;
          for (const q of players.values()) if (q !== target && q.side === want) n++;
          spawnFor(target, n);
        }
        sendLobby();
        broadcast(encFeed(`host moved ${target.name} → ${want === 0 ? 'ATTACK' : 'DEFEND'}`));
      }
    } else if (type === Msg.Fire) {
      onFire(me, decFire(buf));
    } else if (type === Msg.Chat) {
      const now = Date.now();
      if (now - me.lastChat < 500) return; // no spam
      me.lastChat = now;
      const text = decChat(buf).text.slice(0, 64);
      if (text.length === 0) return;
      broadcast(encChat(me.id, text));
    } else if (type === Msg.Ping) {
      const v = new DataView(buf);
      const out = new ArrayBuffer(5);
      const o = new DataView(out);
      o.setUint8(0, Msg.Pong);
      o.setUint32(1, v.getUint32(1, true), true);
      if (ws.readyState === WebSocket.OPEN) ws.send(out);
    }
  });
  ws.on('close', () => {
    if (me) {
      console.log(`leave ${me.name}`);
      players.delete(ws);
      syncOrder();
      if (players.size === 0) nextId = 0;
      if (ws === host) {
        host = null;
        for (const [w] of players) { host = w; break; }
      }
      sendLobby();
      broadcast(encFeed(`${me.name} left`));
    }
  });
});

setInterval(() => {
  // wall-clock catch-up: Windows timer granularity can make 33ms fire late;
  // game time must track wall time or rounds run long.
  const now = Date.now();
  tickAcc += now - lastWake;
  lastWake = now;
  let steps = 0;
  while (tickAcc >= 33 && steps < 4) {
    serverTick();
    tickAcc -= 33;
    steps++;
  }
  if (steps === 4) tickAcc = 0; // hopelessly behind: drop time, don't spiral
}, 33);
let tickAcc = 0;
let lastWake = Date.now();
server.listen(PORT, '0.0.0.0', () => {
  const nets = os.networkInterfaces();
  let lan = 'localhost';
  for (const list of Object.values(nets)) {
    for (const n of list || []) {
      if (n.family === 'IPv4' && !n.internal) { lan = n.address; break; }
    }
  }
  console.log(`\n  SIEGE-LITE LAN on :${PORT}`);
  console.log(`  Open on this PC : http://localhost:${PORT}`);
  console.log(`  Open on LAN     : http://${lan}:${PORT}\n`);
});
