// M5 client: LAN netplay. Prediction + reconcile for you, 100ms interp for
// everyone else, lobby, remote bodies. Server owns all damage/ammo.
import * as THREE from 'three';
import { CFG } from '../shared/config.js';
import { stepPlayer, type Input, type Player } from '../shared/sim.js';
import { buildGrid, type Collider, type Grid } from '../shared/colliders.js';
import { MAP_NAMES } from '../shared/maps.js';
import { interactHint, makeSlots, type Slot } from '../shared/destruct.js';
import { hpColor, makeSiteBeacon, makeTextSprite, paintLoadout, type SiteBeacon, type TextSprite } from './labels.js';
import type { SlotBox } from './mapLoader.js';
import { siteLetter } from './mapLoader.js';
import {
  ACT, BTN, Msg, decBoom, decChat, decFeed, decHit, decLobby, decSnap, decWelcome,
  encAct, encChat, encFire, encHello, encInput, encPing,
  type EntSnap, type LobbyPlayer,
} from '../shared/net.js';
import type { GunRig } from './weapon.js';

interface Hist { seq: number; yaw: number; pitch: number; btn: number; x: number; y: number; z: number; vx: number; vy: number; vz: number; grounded: boolean }
interface SnapSlot { tick: number; time: number; n: number; ents: EntSnap[] }

export class Netplay {
  myId = -1;
  mySide: 0 | 1 = 0;
  private knownName = ''; // server-confirmed unique name (typed name can clash)
  started = false; // match running (left the lobby)
  ping = 0;
  private ws: WebSocket;
  private seq = 0;
  private lastTick = 0;
  private sendAcc = 0;
  private pingAcc = 0;
  private hist: Hist[] = [];
  private histI = 0;
  private snaps: SnapSlot[] = [];
  private lastSnap: EntSnap[] = [];
  private lobby: LobbyPlayer[] = [];
  private settings = { bestOf: 5, prepS: 10, lock: false, stay: true, map: 0 };
  // main sets this to its loaded map right after construct (forces host-map sync)
  curMap = -1;
  onMapChange: ((idx: number) => Promise<void>) | null = null;
  private names = new Map<number, string>();
  private bodies = new Map<number, THREE.Group>();
  private tags = new Map<number, THREE.Sprite>();
  private wasAlive = new Map<number, boolean>();
  private specIdx = -1;
  // destructible slots (server truth via SNAP) + live playfield
  private slots: Slot[] = [];
  private applied: number[] = [-1, -1, -1, -1, -1];
  private appliedHp: number[] = [-1, -1, -1, -1, -1];
  private wallTags: TextSprite[] = [];
  private headTags = new Map<number, TextSprite>();
  private headShown = new Map<number, number>();
  private beacons: { group: THREE.Group; set: SiteBeacon['set']; tick: SiteBeacon['tick'] }[] = [];
  private sitePos: THREE.Vector3[] = [];
  private siteNames: string[] = [];

  setSites(names: string[], coords: number[]): void {
    this.siteNames = [...names];
    this.sitePos = [];
    for (let i = 0; i < names.length; i++) {
      this.sitePos.push(new THREE.Vector3(coords[i * 3], coords[i * 3 + 1], coords[i * 3 + 2]));
    }
    for (const b of this.beacons) this.scene.remove(b.group);
    this.beacons = [];
    for (const n of names) {
      const b = makeSiteBeacon(siteLetter(n));
      this.scene.add(b.group);
      this.beacons.push(b);
    }
  }

  private siteLetter(): string {
    return siteLetter(this.siteNames[this.site] ?? '');
  }
  private activeSite(): THREE.Vector3 {
    return this.sitePos[this.site] ?? this.sitePos[0] ?? new THREE.Vector3();
  }
  world: { colliders: Collider[]; grid: Grid };
  private interactSent = false;
  private lastHint = '';
  private feed: { text: string; t: number }[] = [];
  private snapTmp: EntSnap[] = [];
  private lastResult = '';
  private hudT = 0;
  private inp: Input = { fwd: false, back: false, left: false, right: false, sprint: false, crouch: false, jump: false, yaw: 0 };
  private atkMat = new THREE.MeshBasicMaterial({ color: 0x2a6fd6, fog: true });
  private defMat = new THREE.MeshBasicMaterial({ color: 0xd06a1e, fog: true });
  private darkMat = new THREE.MeshBasicMaterial({ color: 0x222222, fog: true });

  constructor(
    private scene: THREE.Scene,
    private camera: THREE.Camera,
    private gun: GunRig,
    private player: Player,
    private input: { yaw: number; pitch: number; fwd: boolean; back: boolean; left: boolean; right: boolean; sprint: boolean; crouch: boolean; jump: boolean },
    private colliders: Collider[],
    private grid: Grid,
    private name: string,
    side: 0 | 1,
    gunIdx: number,
    private ui: {
      feed: HTMLElement; banner: HTMLElement; center: HTMLElement; board: HTMLElement;
      end: HTMLElement; lan: HTMLElement; interact: HTMLElement; hudExtra: (s: string) => void;
    },
    slotBoxes: SlotBox[],
    private slotMeshes: THREE.Object3D[],
  ) {
    this.mySide = side;
    this.knownName = name;
    // destructible slots start OPEN locally too (server owns truth, SNAP corrects)
    this.slots = makeSlots(slotBoxes);
    const self = new Set(slotBoxes.map((s) => s.name));
    this.world = {
      colliders: colliders.filter((c) => !self.has(c.name)),
      grid: buildGrid([]),
    };
    this.world.grid = buildGrid(this.world.colliders);
    this.gun.setWorld(this.world.colliders, this.world.grid);
    for (const m of this.slotMeshes) m.visible = false; // slots start open
    // wall HP tags at slot centers (sprites face every side)
    for (const sb of slotBoxes) {
      const tag = makeTextSprite(1.5);
      tag.sprite.position.set((sb.min[0] + sb.max[0]) / 2, (sb.min[1] + sb.max[1]) / 2 + 0.4, (sb.min[2] + sb.max[2]) / 2);
      tag.sprite.visible = false;
      this.scene.add(tag.sprite);
      this.wallTags.push(tag);
    }
    for (let i = 0; i < 64; i++) {
      this.hist.push({ seq: 0, yaw: 0, pitch: 0, btn: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, grounded: false });
    }
    for (let i = 0; i < 8; i++) {
      const ents: EntSnap[] = [];
      for (let k = 0; k < 10; k++) {
        ents.push({ id: 0, x: 0, y: 0, z: 0, yaw: 0, hp: 0, alive: false, crouch: false, side: 0, gun: 0 });
      }
      this.snaps.push({ tick: 0, time: 0, n: 0, ents });
    }
    this.ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
    this.ws.binaryType = 'arraybuffer';
    this.ws.onopen = () => this.ws.send(encHello(name, side, gunIdx));
    this.ws.onmessage = (ev) => this.onMsg(ev.data as ArrayBuffer);
    this.ws.onclose = () => this.say('disconnected');
    this.gun.authoritative = true;
    this.gun.hooks = {
      shot: (gi, yaw, pitch) => this.ws.send(encFire({ seq: this.seq, tick: this.lastTick, yaw, pitch, gun: gi })),
      reloadReq: () => this.ws.send(encAct(this.seq, ACT.reload)),
      usePri: () => this.ws.send(encAct(this.seq, ACT.usePri)),
      useSec: () => this.ws.send(encAct(this.seq, ACT.useSec)),
      setPri: (i) => this.ws.send(encAct(this.seq, ACT.setPri0 + i)),
      setSec: (i) => this.ws.send(encAct(this.seq, ACT.setSec0 + i)),
      nadeReq: () => this.ws.send(encAct(this.seq, ACT.nade)),
    };
  }

  // full map swap (host picked another while waiting in lobby)
  reloadMap(colliders: Collider[], grid: Grid, slotBoxes: SlotBox[], slotMeshes: THREE.Object3D[]): void {
    const self = new Set(slotBoxes.map((s) => s.name));
    this.world = {
      colliders: colliders.filter((c) => !self.has(c.name)),
      grid: buildGrid([]),
    };
    this.world.grid = buildGrid(this.world.colliders);
    this.gun.setWorld(this.world.colliders, this.world.grid);
    for (const t of this.wallTags) this.scene.remove(t.sprite);
    this.wallTags = [];
    this.slots = makeSlots(slotBoxes);
    this.applied = [-1, -1, -1, -1, -1];
    this.appliedHp = [-1, -1, -1, -1, -1];
    for (const sb of slotBoxes) {
      const tag = makeTextSprite(1.5);
      tag.sprite.position.set((sb.min[0] + sb.max[0]) / 2, (sb.min[1] + sb.max[1]) / 2 + 0.4, (sb.min[2] + sb.max[2]) / 2);
      tag.sprite.visible = false;
      this.scene.add(tag.sprite);
      this.wallTags.push(tag);
    }
    this.slotMeshes = slotMeshes;
    for (const m of slotMeshes) m.visible = false;
  }

  close(): void {
    try { this.ws.close(); } catch { /* gone */ }
    for (const b of this.beacons) this.scene.remove(b.group);
    this.gun.authoritative = false;
    this.gun.hooks = null;
    for (const [, g] of this.bodies) this.scene.remove(g);
    this.bodies.clear();
    for (const [, t] of this.tags) this.scene.remove(t);
    this.tags.clear();
    for (const [, t] of this.headTags) this.scene.remove(t.sprite);
    this.headTags.clear();
    for (const t of this.wallTags) this.scene.remove(t.sprite);
  }

  // F key from main (edge-sent as ACT). Shows the local hint too.
  setInteract(holding: boolean): void {
    if (holding === this.interactSent) return;
    this.interactSent = holding;
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(encAct(this.seq, holding ? ACT.interact : ACT.interactEnd));
    }
  }

  private applySlots(states: number[], hp: number[]): void {
    for (let i = 0; i < this.slots.length && i < states.length; i++) {
      const tag = this.wallTags[i];
      if (states[i] !== this.applied[i] || hp[i] !== this.appliedHp[i]) {
        this.applied[i] = states[i];
        this.appliedHp[i] = hp[i];
        const s = this.slots[i];
        s.state = states[i] === 1 ? 'reinforced' : states[i] === 2 ? 'breached' : 'open';
        s.hp = hp[i];
        this.slotMeshes[i].visible = s.state === 'reinforced';
        if (tag) {
          tag.sprite.visible = s.state === 'reinforced';
          if (s.state === 'reinforced') tag.set(`${Math.ceil(s.hp)}`, hpColor(s.hp, 50));
        }
        const wl = this.world.colliders;
        for (let k = wl.length - 1; k >= 0; k--) {
          if (wl[k].name === s.name) wl.splice(k, 1);
        }
        if (s.state === 'reinforced') {
          wl.push({
            kind: 'box', name: s.name, group: 'wall',
            minX: s.minX, minY: s.minY, minZ: s.minZ,
            maxX: s.maxX, maxY: s.maxY, maxZ: s.maxZ,
          });
        }
        this.world.grid = buildGrid(wl);
        this.gun.setWorld(wl, this.world.grid);
      }
    }
  }

  get myEnt(): EntSnap | null {
    for (const e of this.lastSnap) if (e.id === this.myId) return e;
    return null;
  }

  myHp(): number { return this.myEnt?.hp ?? 100; }
  amAlive(): boolean { return this.myEnt?.alive ?? true; }
  frozen(): boolean {
    return this.phase === 0 && this.mySide === 0;
  }

  // ---- network ----
  private onMsg(buf: ArrayBuffer): void {
    const type = new DataView(buf).getUint8(0);
    if (type === Msg.Welcome) {
      // authoritative: your id + unique name (never match by typed name)
      const w = decWelcome(buf);
      this.myId = w.id;
      this.knownName = w.name;
    } else if (type === Msg.Lobby) {
      const lob = decLobby(buf);
      this.lobby = lob.players;
      this.settings = lob.settings;
      for (const p of this.lobby) this.names.set(p.id, p.name);
      if (this.myId < 0) {
        // fallback (shouldn't happen): match by typed name
        const me = this.lobby.find((p) => p.name === this.knownName);
        if (me) this.myId = me.id;
      }
      // host's map wins, always: converge while waiting or between matches
      if (this.onMapChange && lob.settings.map !== this.curMap && (!this.started || this.phase === 3)) {
        this.curMap = lob.settings.map;
        void this.onMapChange(lob.settings.map);
      }
      this.renderLobby();
    } else if (type === Msg.Snap) {
      this.snapTmp.length = 0;
      const s = decSnap(buf, this.snapTmp);
      this.lastTick = s.tick;
      this.applySlots(s.slots, s.slotHp);
      this.storeSnap(s);
      this.reconcile(s);
      this.phase = s.phase; this.phaseT = s.phaseT;
      this.round = s.round; this.atkW = s.atkWins; this.defW = s.defWins;
      this.site = s.teamSite; this.secureT = s.secureT;
      if (!this.started && (s.phase === 0 || s.phase === 1)) {
        this.started = true;
        this.ui.lan.style.display = 'none';
      }
    } else if (type === Msg.Hit) {
      const h = decHit(buf);
      const sn = this.names.get(h.shooter) ?? `#${h.shooter}`;
      const vn = this.names.get(h.victim) ?? `#${h.victim}`;
      if (h.shooter === this.myId) {
        this.gun.noteHit(`HIT ${h.dmg}${h.head ? ' HEAD' : ''}`);
      }
      if (h.kill) this.say(`${sn} killed ${vn}${h.head ? ' (head)' : ''}`);
    } else if (type === Msg.Boom) {
      const b = decBoom(buf);
      this.gun.applyBlast(b.x, b.y, b.z);
    } else if (type === Msg.Round) {
      const v = new DataView(buf);
      this.onRound(v.getUint8(1), v.getUint8(2));
    } else if (type === Msg.Pong) {
      const v = new DataView(buf);
      this.ping = Date.now() - v.getUint32(1, true);
    } else if (type === Msg.Ammo) {
      const v = new DataView(buf);
      this.gun.setServerAmmo(v.getUint8(1), v.getUint8(2), v.getUint8(3) !== 0);
    } else if (type === Msg.Feed) {
      this.say(decFeed(buf));
    } else if (type === Msg.Chat) {
      const c = decChat(buf);
      const nm = this.names.get(c.sender) ?? `#${c.sender}`;
      this.chatFeed.push({ text: `[${nm}] ${c.text}` });
      if (this.chatFeed.length > 6) this.chatFeed.shift();
      this.renderChat();
    }
  }

  phase = 0; phaseT = 0; round = 1; atkW = 0; defW = 0; site = 0; secureT = 0;

  sendStart(): void {
    this.ws.send(encAct(this.seq, ACT.start));
  }

  sendChat(text: string): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(encChat(this.myId, text));
  }

  amHost(): boolean {
    return this.lobby.some((p) => p.id === this.myId && p.host);
  }

  private onRound(code: number, aux: number): void {
    if (code === 0) this.say(`Round ${aux} starts`);
    else if (code === 1) this.say('GO!');
    else if (code === 2) { this.lastResult = `ATTACKERS take round ${this.round}`; this.say(this.lastResult); }
    else if (code === 3) { this.lastResult = `DEFENDERS take round ${this.round}`; this.say(this.lastResult); }
    else if (code === 4) { this.lastResult = `ATTACKERS take it ${this.atkW}-${this.defW}`; this.showEnd(this.lastResult); }
    else if (code === 5) { this.lastResult = `DEFENDERS take it ${this.atkW}-${this.defW}`; this.showEnd(this.lastResult); }
  }

  private showEnd(text: string): void {
    this.ui.end.style.display = 'flex';
    this.ui.end.querySelector('.msg')!.textContent = `${text} (click to leave)`;
  }

  // ---- prediction ----
  private btnBits(): number {
    const i = this.input;
    return (i.fwd ? BTN.fwd : 0) | (i.back ? BTN.back : 0) | (i.left ? BTN.left : 0) |
      (i.right ? BTN.right : 0) | (i.sprint ? BTN.sprint : 0) | (i.crouch ? BTN.crouch : 0) |
      (i.jump ? BTN.jump : 0);
  }

  update(dt: number): void {
    // send input at 30Hz + record history for reconcile
    this.sendAcc += dt;
    if (this.sendAcc >= 1 / 30 && this.ws.readyState === WebSocket.OPEN && this.started) {
      this.sendAcc = 0;
      this.seq++;
      const btn = this.btnBits();
      this.ws.send(encInput({ seq: this.seq, yaw: this.input.yaw, pitch: this.input.pitch, btn, ads: 0 }));
      const h = this.hist[this.histI];
      this.histI = (this.histI + 1) % this.hist.length;
      h.seq = this.seq; h.yaw = this.input.yaw; h.pitch = this.input.pitch; h.btn = btn;
      h.x = this.player.x; h.y = this.player.y; h.z = this.player.z;
      h.vx = this.player.vx; h.vy = this.player.vy; h.vz = this.player.vz;
      h.grounded = this.player.grounded;
    }
    this.pingAcc += dt;
    if (this.pingAcc > 2 && this.ws.readyState === WebSocket.OPEN) {
      this.pingAcc = 0;
      this.ws.send(encPing(Date.now() & 0xffffffff));
    }
    for (const f of this.feed) f.t -= dt;
    this.hudT += dt;
    // F hint near slots (rules evaluated locally, server owns truth)
    {
      const side = this.mySide === 0 ? 'atk' : 'def';
      const ph = this.phase === 0 ? 'prep' : this.phase === 1 ? 'action' : '';
      const hint = this.amAlive() && ph ? interactHint(this.slots, side, ph, this.player.x, this.player.y, this.player.z) : '';
      if (hint !== this.lastHint) {
        this.lastHint = hint;
        this.ui.interact.textContent = hint ? `[F] ${hint}` : '';
      }
    }
    this.hudT += dt;
    if (this.hudT > 0.25) { this.hudT = 0; this.renderHud(); }
  }

  private reconcile(s: { ack: number; ents: EntSnap[] }): void {
    let me: EntSnap | null = null;
    for (const e of s.ents) if (e.id === this.myId) { me = e; break; }
    if (!me) return;
    this.lastSnap = s.ents;
    // my side can change (team switch approved by server)
    if (me.side !== this.mySide) this.mySide = me.side as 0 | 1;
    // find history at ack
    let h: Hist | null = null;
    for (const c of this.hist) if (c.seq === s.ack) { h = c; break; }
    if (!h || h.seq === 0) {
      // no baseline yet (or respawn jump): trust server
      this.player.x = me.x; this.player.y = me.y; this.player.z = me.z;
      this.player.vx = this.player.vy = this.player.vz = 0;
      return;
    }
    const err = Math.hypot(me.x - h.x, me.y - h.y, me.z - h.z);
    if (err < 0.25) return; // close enough: keep predicting
    // snap + replay newer inputs
    this.player.x = me.x; this.player.y = me.y; this.player.z = me.z;
    this.player.vx = this.player.vy = this.player.vz = 0;
    this.player.grounded = true;
    const newer: Hist[] = [];
    for (const c of this.hist) {
      const d = (c.seq - s.ack + 65536) % 65536;
      if (c.seq !== 0 && d > 0 && d < 60) newer.push(c);
    }
    newer.sort((a, b) => a.seq - b.seq);
    for (const c of newer) {
      this.inp.fwd = (c.btn & BTN.fwd) !== 0; this.inp.back = (c.btn & BTN.back) !== 0;
      this.inp.left = (c.btn & BTN.left) !== 0; this.inp.right = (c.btn & BTN.right) !== 0;
      this.inp.sprint = (c.btn & BTN.sprint) !== 0; this.inp.crouch = (c.btn & BTN.crouch) !== 0;
      this.inp.jump = (c.btn & BTN.jump) !== 0; this.inp.yaw = c.yaw;
      stepPlayer(this.player, this.inp, 1 / 30, this.world.colliders, this.world.grid, 1);
    }
  }

  // ---- interpolation ----
  private storeSnap(s: { tick: number; ents: EntSnap[] }): void {
    let slot = this.snaps[0];
    for (const q of this.snaps) if (q.time <= slot.time) slot = q;
    slot.tick = s.tick;
    slot.time = performance.now() / 1000;
    slot.n = s.ents.length;
    for (let i = 0; i < s.ents.length; i++) {
      const a = s.ents[i], b = slot.ents[i];
      b.id = a.id; b.x = a.x; b.y = a.y; b.z = a.z; b.yaw = a.yaw;
      b.hp = a.hp; b.alive = a.alive; b.crouch = a.crouch; b.side = a.side; b.gun = a.gun;
    }
  }

  render(): void {
    const now = performance.now() / 1000 - 0.1; // 100ms interp buffer
    let a = this.snaps[0], b = this.snaps[0];
    for (const q of this.snaps) {
      if (q.time <= now && q.time >= a.time) a = q;
      if (q.time >= now && (b.time < now || q.time < b.time)) b = q;
    }
    const span = b.time - a.time;
    const alpha = span > 0.0001 ? Math.max(0, Math.min(1, (now - a.time) / span)) : 1;
    const seen = new Set<number>();
    for (let i = 0; i < b.n; i++) {
      const e1 = b.ents[i];
      if (e1.id === this.myId) continue; // you are predicted, not interp'd
      seen.add(e1.id);
      let e0: EntSnap | null = null;
      for (let k = 0; k < a.n; k++) if (a.ents[k].id === e1.id) { e0 = a.ents[k]; break; }
      const body = this.ensureBody(e1.id, e1.side, e1.id);
      const px = e0 ? e0.x + (e1.x - e0.x) * alpha : e1.x;
      const py = e0 ? e0.y + (e1.y - e0.y) * alpha : e1.y;
      const pz = e0 ? e0.z + (e1.z - e0.z) * alpha : e1.z;
      body.position.set(px, py, pz);
      let yaw = e1.yaw;
      if (e0) {
        let d = e1.yaw - e0.yaw;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        yaw = e0.yaw + d * alpha;
      }
      body.rotation.y = yaw;
      body.scale.y = e1.crouch ? 0.65 : 1;
      const was = this.wasAlive.get(e1.id);
      if (was !== e1.alive) {
        this.wasAlive.set(e1.id, e1.alive);
        body.rotation.x = e1.alive ? 0 : -1.5;
      }
      // hp bar over every head
      let ht = this.headTags.get(e1.id);
      if (!ht) {
        ht = makeTextSprite(0.85);
        this.scene.add(ht.sprite);
        this.headTags.set(e1.id, ht);
      }
      ht.sprite.position.set(px, py + 2.1, pz);
      ht.sprite.visible = e1.alive && e1.id !== this.myId;
      // friends show through walls, enemies only in the open
      (ht.sprite.material as THREE.SpriteMaterial).depthTest = e1.side === this.mySide;
      if (e1.alive && this.headShown.get(e1.id) !== e1.hp) {
        this.headShown.set(e1.id, e1.hp);
        ht.set(`${Math.ceil(e1.hp)}/300`, hpColor(e1.hp, CFG.playerHp));
      }
    }
    for (const [id, g] of this.bodies) {
      if (!seen.has(id)) g.visible = false;
      else g.visible = id !== this.myId || !this.amAlive();
    }
    // active-site beacon for both teams (orange attack, blue defend)
    {
      const color = this.mySide === 0 ? 0xff9030 : 0x3a90ff;
      const s = this.activeSite();
      const show = this.started && this.phase !== 3;
      for (let i = 0; i < this.beacons.length; i++) {
        const on = show && i === this.site;
        this.beacons[i].group.visible = on;
        if (on) {
          this.beacons[i].set(s.x, s.y, s.z, color);
          this.beacons[i].tick(0.016);
        }
      }
    }
  }

  private ensureBody(id: number, side: number, _id: number): THREE.Group {
    void _id;
    let g = this.bodies.get(id);
    if (!g) {
      g = new THREE.Group();
      const m = side === 0 ? this.atkMat : this.defMat;
      const legs = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.8, 0.4), this.darkMat);
      legs.position.y = 0.4;
      const torso = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.7, 0.35), m);
      torso.position.y = 1.15;
      torso.name = 'team';
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 8), m);
      head.position.y = 1.62;
      head.name = 'team';
      const gunM = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.1, 0.6), this.darkMat);
      gunM.position.set(0.25, 1.3, -0.35);
      g.add(legs, torso, head, gunM);
      this.scene.add(g);
      this.bodies.set(id, g);
      this.wasAlive.set(id, true);
      // name tag for teammates
      const tag = this.makeTag(this.names.get(id) ?? `#${id}`);
      tag.position.y = 2.1;
      g.add(tag);
      this.tags.set(id, tag);
    }
    // recolor on side swap (children named 'team')
    const want = side === 0 ? this.atkMat : this.defMat;
    g.traverse((o) => {
      if (o.name === 'team') (o as THREE.Mesh).material = want;
    });
    // tag only for teammates
    const tag = this.tags.get(id);
    if (tag) tag.visible = side === this.mySide;
    return g;
  }

  private makeTag(text: string): THREE.Sprite {
    const c = document.createElement('canvas');
    c.width = 128; c.height = 32;
    const g2 = c.getContext('2d')!;
    g2.font = 'bold 22px monospace';
    g2.textAlign = 'center';
    g2.fillStyle = '#fff';
    g2.fillText(text.slice(0, 10), 64, 24);
    const tex = new THREE.CanvasTexture(c);
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, fog: false, depthTest: false, transparent: true }));
    s.scale.set(1.1, 0.28, 1);
    s.renderOrder = 998;
    return s;
  }

  nextSpectate(): void {
    // cycle alive teammates in latest snap
    const mates: number[] = [];
    for (const e of this.lastSnap) {
      if (e.id !== this.myId && e.alive && e.side === this.mySide) mates.push(e.id);
    }
    if (mates.length === 0) return;
    const i = mates.indexOf(this.specId);
    this.specId = mates[(i + 1) % mates.length];
  }
  private specId = -1;

  spectateCam(cam: THREE.Camera): void {
    let target: EntSnap | null = null;
    for (const e of this.lastSnap) {
      if (e.id !== this.myId && e.alive && e.side === this.mySide) {
        if (e.id === this.specId) { target = e; break; }
        if (!target) target = e;
      }
    }
    if (!target) return;
    this.specId = target.id;
    cam.position.set(target.x, target.y + (target.crouch ? CFG.eyeCrouch : CFG.eyeStand), target.z);
    cam.rotation.order = 'YXZ';
    cam.rotation.y = target.yaw;
    cam.rotation.x = 0;
  }

  // ---- hud ----
  private say(text: string): void {
    this.feed.push({ text, t: 5 });
    if (this.feed.length > 5) this.feed.shift();
    this.ui.feed.innerHTML = this.feed.map((f) => `<div>${f.text}</div>`).join('');
  }

  private chatFeed: { text: string }[] = [];

  private renderChat(): void {
    // chat stays up for everyone, all the time (last 6, no fade)
    document.getElementById('chat')!.innerHTML = this.chatFeed.map((f) => `<div>${f.text}</div>`).join('');
  }

  private renderLobby(): void {
    const box = document.getElementById('lanlist')!;
    const host = this.amHost();
    box.innerHTML = this.lobby.map((p) => {
      const move = host && p.id !== this.myId
        ? ` <span data-move="${p.id}" style="color:#8cf;cursor:pointer;">[move]</span>` : '';
      return `<div>${p.host ? '★' : ''} ${p.name} [${p.side === 0 ? 'ATK' : 'DEF'}]${move}</div>`;
    }).join('') || '<div>waiting…</div>';
    box.querySelectorAll<HTMLSpanElement>('span[data-move]').forEach((s) => {
      s.onclick = () => this.ws.send(encAct(this.seq, ACT.movePlayer, Number(s.dataset.move)));
    });
    const start = document.getElementById('lanstart') as HTMLButtonElement;
    if (start) start.style.display = host ? 'inline-block' : 'none';
    // host settings, read-only for everyone else
    const set = document.getElementById('lansettings')!;
    const s = this.settings;
    if (host) {
      const mapBtns = [0, 1, 2].map((m) =>
        `<button data-map="${m}" ${m === s.map ? 'disabled' : ''}>${MAP_NAMES[m]}</button>`).join(' ');
      set.innerHTML =
        `<div>Map: ${mapBtns}</div>` +
        `<div>Best of: ${[1, 3, 5, 7].map((b) => `<button data-best="${b}" ${b === s.bestOf ? 'disabled' : ''}>${b}</button>`).join(' ')}</div>` +
        `<div>Prep: ${[5, 10, 15].map((p) => `<button data-prep="${p}" ${p === s.prepS ? 'disabled' : ''}>${p}s</button>`).join(' ')}</div>` +
        `<div><button data-lock="1">${s.lock ? 'Unlock teams' : 'Lock teams'}</button> ` +
        `<button data-stay="1">${s.stay ? 'Leave after match' : 'Stay in lobby'}</button></div>`;
      set.querySelectorAll<HTMLButtonElement>('button[data-map]').forEach((b) => {
        b.onclick = () => this.ws.send(encAct(this.seq, ACT.setMap, Number(b.dataset.map)));
      });
      set.querySelectorAll<HTMLButtonElement>('button[data-best]').forEach((b) => {
        b.onclick = () => this.ws.send(encAct(this.seq, ACT.setBest, Number(b.dataset.best)));
      });
      set.querySelectorAll<HTMLButtonElement>('button[data-prep]').forEach((b) => {
        b.onclick = () => this.ws.send(encAct(this.seq, ACT.setPrep, Number(b.dataset.prep)));
      });
      const lock = set.querySelector<HTMLButtonElement>('button[data-lock]');
      if (lock) lock.onclick = () => this.ws.send(encAct(this.seq, ACT.setLock, s.lock ? 0 : 1));
      const stay = set.querySelector<HTMLButtonElement>('button[data-stay]');
      if (stay) stay.onclick = () => this.ws.send(encAct(this.seq, ACT.setStay, s.stay ? 0 : 1));
    } else {
      set.innerHTML = `<div>${MAP_NAMES[s.map] ?? 'House'} · Best of ${s.bestOf} · prep ${s.prepS}s · teams ${s.lock ? 'locked' : 'open'} · ${s.stay ? 'stay in lobby' : 'leave after match'}</div>`;
    }
  }

  stayInLobby(): boolean { return this.settings.stay; }

  backToLobby(): void {
    this.started = false;
    this.ui.end.style.display = 'none';
    this.ui.center.style.display = 'none';
    this.ui.lan.style.display = 'flex';
    document.exitPointerLock?.();
  }

  private renderHud(): void {
    // loadout picker lives in the breaks (prep + round end)
    paintLoadout(this.phase === 0 || this.phase === 2, this.gun.loadout.primary, this.gun.loadout.secondary);
    const t = Math.max(0, this.phaseT);
    const mm = Math.floor(t / 60), ss = Math.floor(t % 60).toString().padStart(2, '0');
    const ph = this.phase === 0 ? 'PREP' : this.phase === 1 ? 'ACTION' : this.phase === 2 ? 'ROUND' : 'END';
    this.ui.banner.innerHTML =
      `<div>${ph} ${mm}:${ss} · R${this.round} · ATK ${this.atkW} - ${this.defW} DEF · site ${this.siteLetter()} (you: ${this.mySide === 0 ? 'ATK' : 'DEF'})</div>`;
    const center = this.ui.center;
    if (this.phase === 0 && this.started) {
      center.style.display = 'block';
      center.textContent = `ROUND ${this.round}\n${this.mySide === 0 ? 'YOU ATTACK' : 'YOU DEFEND'} · SITE ${this.siteLetter()}\n${Math.ceil(t)}`;
    } else if (this.phase === 1 && this.phaseT > CFG.actionS - 2.5) {
      center.style.display = 'block';
      center.textContent = 'GO!';
    } else if (this.phase === 2) {
      center.style.display = 'block';
      center.textContent = `${this.lastResult}\nnext round in ${Math.ceil(t)}`;
    } else center.style.display = 'none';
    // secure bar from snap secureT
    const sec = document.getElementById('secure')!;
    const fill = document.getElementById('securefill')!;
    if (this.phase === 1 && this.secureT > 0.05) {
      sec.style.display = 'block';
      fill.style.width = `${Math.min(100, (this.secureT / CFG.secureTime) * 100)}%`;
    } else sec.style.display = 'none';
    this.ui.hudExtra(`ping ${this.ping}ms`);
  }

  setScoreboard(on: boolean): void {
    const el = this.ui.board;
    el.style.display = on ? 'block' : 'none';
    if (!on) return;
    let html = '<div><b>TAB — LAN scores (M quits)</b></div>';
    for (const p of this.lobby) {
      let alive: string = '?';
      for (const q of this.lastSnap) if (q.id === p.id) { alive = q.alive ? 'alive' : 'DEAD'; break; }
      html += `<div>${p.host ? '★' : ''} ${p.name} [${p.side === 0 ? 'ATK' : 'DEF'}] ${alive}</div>`;
    }
    html += `<div id="switchteam" style="color:#8cf;cursor:pointer;">SWITCH TEAM</div>`;
    el.innerHTML = html;
    const btn = document.getElementById('switchteam');
    if (btn) btn.onclick = () => this.ws.send(encAct(this.seq, ACT.team));
  }
}
