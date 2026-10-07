// M4: solo match controller. Owns 6 entities (you + 5 bots), bot bodies,
// round flow, kill feed, scoreboard, spectating. Server (M5) will own the
// same logic headlessly; this file is the client presenter + bot stepper.
import * as THREE from 'three';
import { CFG } from '../shared/config.js';
import { makePlayer, stepPlayer, type Input, type Player } from '../shared/sim.js';
import { makeBot, thinkBot, type Bot, type BotCmd, type BotCtx, type Ent, type Role } from '../shared/bots.js';
import { buildNav, type NavGraph } from '../shared/nav.js';
import { makeMatch, updateMatch, type Match as MatchState, type Side } from '../shared/rounds.js';
import { fireHitscan, hurt, makePelletPool, type ShootEnt } from '../shared/combat.js';
import { blastDamage } from '../shared/grenade.js';
import { buildGrid, raycast, type Collider, type Grid } from '../shared/colliders.js';
import { interactHint, damageSlot, makeSlots, resetSlots, slotAtPoint, stepBreach, tryReinforce, type Slot } from '../shared/destruct.js';
import { hpColor, makeSiteBeacon, makeTextSprite, paintLoadout, type SiteBeacon, type TextSprite } from './labels.js';
import type { SlotBox } from './mapLoader.js';
import { findMarker, hasTag, siteLetter } from './mapLoader.js';
import { WEAPONS } from '../shared/weapons.js';
import type { GunRig } from './weapon.js';

const NAMES = ['You', 'Ivy', 'Rook', 'Ash', 'Blitz', 'Doc'];

export class SoloMatch {
  entities: Ent[] = [];
  sims: Player[] = [];
  bots: (Bot | null)[] = [];
  cmds: BotCmd[] = [];
  shootEnts: ShootEnt[] = [];
  kills: number[] = [0, 0, 0, 0, 0, 0];
  bodies: THREE.Group[] = [];
  guns: THREE.Mesh[] = [];
  st: MatchState;
  chosen: Side;
  nav: NavGraph;
  botCtx: BotCtx;
  sites: { name: string; pos: THREE.Vector3 }[];
  specIdx = 1;
  over = false;
  playerScore = 0; // rounds won while on YOUR current side
  playerSpawn = new THREE.Vector3(0, 0.1, -14);
  playerTeleport = false; // main picks up spawn after resets
  private lastMark: THREE.Mesh; // last-alive-enemy diamond (no hide-and-seek)
  private beacons: { group: THREE.Group; set: SiteBeacon['set']; tick: SiteBeacon['tick'] }[] = [];
  private siteLetter(): string {
    return siteLetter(this.sites[this.st.teamSite]?.name ?? '');
  }
  private activeSite(): THREE.Vector3 {
    return this.sites[this.st.teamSite]?.pos ?? new THREE.Vector3();
  }
  private onHitCb = (idx: number, dmg: number, head: boolean) => {
    this.damageEntity(idx, dmg, head, 'You');
  };
  private pellets = makePelletPool(8);
  private cmd: BotCmd = { yaw: 0, pitch: 0, fwd: false, back: false, left: false, right: false, crouch: false, jump: false, wantFire: false };
  private inp: Input = { fwd: false, back: false, left: false, right: false, sprint: false, crouch: false, jump: false, yaw: 0 };
  private feedEl = document.getElementById('feed')!;
  private bannerEl = document.getElementById('banner')!;
  private centerEl = document.getElementById('center')!;
  private secureEl = document.getElementById('secure')!;
  private secureFill = document.getElementById('securefill')!;
  private boardEl = document.getElementById('board')!;
  private endEl = document.getElementById('matchend')!;
  private feed: { text: string; t: number }[] = [];
  private lastResult = '';
  private hudT = 0;
  private rng = Math.random;
  // destructible slots: open at round start, defender F reinforces, attacker F breaches
  private slots: Slot[] = [];
  private slotMeshes: THREE.Object3D[] = [];
  world: { colliders: Collider[]; grid: Grid }; // live playfield (slots add/remove)
  private interactHeld = false;
  private lastHint = '';
  private interactEl = document.getElementById('interact')!;
  private lastReinf = -1000; // 1s between reinforces (negative = ready now)
  private wallTags: TextSprite[] = [];
  private headTags: (TextSprite | null)[] = [];
  private headShown: number[] = [-1, -1, -1, -1, -1, -1];

  constructor(
    private scene: THREE.Scene,
    private gun: GunRig,
    private colliders: Collider[],
    private grid: Grid,
    private markers: Record<string, THREE.Vector3>,
    side: Side,
    difficulty: 'recruit' | 'regular',
    slotBoxes: SlotBox[],
    slotMeshes: THREE.Object3D[],
    nav: NavGraph,
  ) {
    this.chosen = side;
    this.sites = Object.keys(markers)
      .filter((k) => hasTag(k, 'Objective_'))
      .sort()
      .map((name) => ({ name, pos: markers[name].clone() }));
    if (this.sites.length === 0) this.sites.push({ name: 'Objective_A_None', pos: new THREE.Vector3() });
    this.nav = nav;
    // play starts with every slot OPEN: drop the self-colliders from our copy
    this.slots = makeSlots(slotBoxes);
    this.slotMeshes = slotMeshes;
    const self = new Set(slotBoxes.map((s) => s.name));
    this.world = {
      colliders: colliders.filter((c) => !self.has(c.name)),
      grid: buildGrid([]),
    };
    this.world.grid = buildGrid(this.world.colliders);
    this.st = makeMatch(side, this.rng, undefined, this.sites.length);
    this.botCtx = {
      nav: this.nav,
      losClear: (x1, y1, z1, x2, y2, z2) => {
        const dx = x2 - x1, dy = y2 - y1, dz = z2 - z1;
        const d = Math.hypot(dx, dy, dz);
        if (d < 0.001) return true;
        const wl = this.world.colliders;
        return raycast(wl, x1, y1, z1, dx / d, dy / d, dz / d, d - 0.3).dist >= d - 0.3;
      },
      sites: this.sites.map((s) => ({ x: s.pos.x, z: s.pos.z })),
      teamSite: this.st.teamSite,
      holdAttacks: true,
      freeze: true,
      rng: this.rng,
    };
    // entities: 0 = you, 1-2 allies, 3-5 enemies
    const allySide: Side = side;
    const foeSide: Side = side === 'atk' ? 'def' : 'atk';
    const roles: Role[] = foeSide === 'def'
      ? ['push', 'push', 'guardA', 'guardB', 'roam']
      : ['guardA', 'guardB', 'push', 'push', 'push'];
    const botGuns = ['ar', 'smg', 'ar', 'smg', 'shotgun'];
    for (let i = 0; i < 6; i++) {
      const isYou = i === 0;
      const sd: Side = i < 3 ? allySide : foeSide;
      this.entities.push({ x: 0, y: 0, z: 0, hp: CFG.playerHp, alive: true, crouch: false, side: sd });
      this.sims.push(makePlayer(0, 0, 14));
      this.cmds.push({ yaw: 0, pitch: 0, fwd: false, back: false, left: false, right: false, crouch: false, jump: false, wantFire: false });
      this.shootEnts.push({ x: 0, y: 0, z: 0, crouch: false, alive: true, side: sd });
      if (isYou) this.bots.push(null);
      else {
        const b = makeBot(roles[i - 1], difficulty, 0.03 * i);
        // enemies a notch sharper than allies (see config)
        const mul = i < 3 ? [CFG.allyReactMul, CFG.allyErrMul] : [CFG.foeReactMul, CFG.foeErrMul];
        b.reactCfg *= mul[0];
        b.errCfg *= mul[1];
        b.gun = botGuns[i - 1];
        b.mag = WEAPONS[b.gun].mag;
        this.bots.push(b);
      }
      this.buildBody(i, sd);
    }
    this.resetPositions();
    this.refreshSides();
    this.lastMark = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.18),
      new THREE.MeshBasicMaterial({ color: 0xff2222, fog: false, depthTest: false, transparent: true, opacity: 0.9 }));
    this.lastMark.renderOrder = 999;
    this.lastMark.visible = false;
    this.scene.add(this.lastMark);
    // one beacon per site; only the live one shows
    for (const s of this.sites) {
      const b = makeSiteBeacon(siteLetter(s.name));
      this.scene.add(b.group);
      this.beacons.push(b);
    }
    // wall HP tags (one per slot, shown while reinforced)
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      const tag = makeTextSprite(1.5);
      tag.sprite.position.set((s.minX + s.maxX) / 2, (s.minY + s.maxY) / 2 + 0.4, (s.minZ + s.maxZ) / 2);
      tag.sprite.visible = false;
      this.scene.add(tag.sprite);
      this.wallTags.push(tag);
    }
    this.say(`Match start — you are ${side === 'atk' ? 'ATTACK' : 'DEFEND'}`);
  }

  private refreshSides(): void {
    this.gun.setEntities(this.shootEnts, this.st.playerSide, this.onHitCb);
    this.gun.onWorldHit = (x, y, z, dmg) => this.chipWall(x, y, z, dmg, 'You');
  }

  // bullets vs reinforced walls (you + bots share this)
  private chipWall(x: number, y: number, z: number, dmg: number, by: string): void {
    const at = slotAtPoint(this.slots, x, y, z);
    if (!at) return;
    const broke = damageSlot(this.slots, at.name, dmg);
    const i = this.slots.indexOf(at);
    const tag = this.wallTags[i];
    if (tag && at.state === 'reinforced') tag.set(`${Math.ceil(at.hp)}`, hpColor(at.hp, 50));
    if (broke) {
      this.applySlot(i);
      this.gun.setWorld(this.world.colliders, this.world.grid);
      this.say(`${by} shot open ${broke.name}!`);
    }
  }

  dispose(): void {
    for (const g of this.bodies) this.scene.remove(g);
    this.scene.remove(this.lastMark);
    for (const b of this.beacons) this.scene.remove(b.group);
    for (const t of this.wallTags) this.scene.remove(t.sprite);
    this.gun.setEntities([], 'atk', () => undefined);
    this.gun.onWorldHit = null;
  }

  playerSide(): Side { return this.st.playerSide; }
  playerFrozen(): boolean {
    return this.st.phase === 'prep' && this.st.playerSide === 'atk';
  }
  playerAlive(): boolean { return this.entities[0].alive; }
  playerHp(): number { return this.entities[0].hp; }

  private spawnFor(slot: number, side: Side): THREE.Vector3 {
    const atkSpots = ['Spawn_Attacker_1', 'Spawn_Attacker_2', 'Spawn_Attacker_3']
      .map((n) => findMarker(this.markers, n))
      .filter((m): m is THREE.Vector3 => !!m);
    if (side === 'atk') return (atkSpots[slot % Math.max(1, atkSpots.length)] ?? new THREE.Vector3()).clone();
    // defenders spawn ON the active site (whoever holds it, spreads around it)
    const s = this.activeSite();
    const off = [[1.5, 1.5], [-1.5, 1.5], [0, -2.5]][slot % 3];
    return new THREE.Vector3(s.x + off[0], s.y, s.z + off[1]);
  }

  resetPositions(): void {
    // whole friendly trio swaps sides together (you + your 2 bots)
    const allySide: Side = this.st.playerSide;
    const foeSide: Side = allySide === 'atk' ? 'def' : 'atk';
    let ai = 0, di = 0;
    for (let i = 0; i < 6; i++) {
      const e = this.entities[i];
      e.side = i < 3 ? allySide : foeSide;
      this.shootEnts[i].side = e.side;
      e.hp = CFG.playerHp; e.alive = true;
      const sp = this.spawnFor(i < 3 ? ai++ : di++, e.side);
      e.x = sp.x; e.y = sp.y + 0.1; e.z = sp.z;
      if (i === 0) {
        this.playerSpawn.set(e.x, e.y, e.z);
        this.playerTeleport = true; // main moves the real player sim
      }
      const s = this.sims[i];
      s.x = e.x; s.y = e.y; s.z = e.z; s.vx = s.vy = s.vz = 0; s.grounded = false;
      const b = this.bots[i];
      if (b) {
        // roles follow the side: defenders guard, attackers push
        const slot = i < 3 ? ai - 1 : di - 1;
        b.role = e.side === 'atk' ? 'push' : (['guardA', 'guardB', 'roam'] as const)[slot % 3];
        b.yaw = e.side === 'atk' ? 0 : Math.PI; // attackers face the house (-Z)
        b.pathN = 0; b.enemy = -1; b.react = 0;
        b.mag = WEAPONS[b.gun].mag; b.reloadT = 0;
      }
      const g = this.bodies[i];
      g.rotation.x = 0;
      g.visible = i !== 0; // hide your own body in first person
      this.paintBody(i, e.side);
    }
    this.specIdx = 1;
    this.refreshSides();
    this.resetSlots();
  }

  // --- destructibles: all open at round start, bots pre-reinforce nearby ---
  private resetSlots(): void {
    resetSlots(this.slots);
    for (let i = 0; i < this.slots.length; i++) this.applySlot(i);
    // defender bots instantly reinforce the closest open slot within 4m
    // (they're frozen in prep, so no walking: spawn does the setup)
    for (let i = 1; i < 6; i++) {
      const e = this.entities[i];
      if (e.side !== 'def') continue;
      let best = -1, bd = 16;
      for (let s = 0; s < this.slots.length; s++) {
        if (this.slots[s].state !== 'open') continue;
        const sl = this.slots[s];
        const cx = (sl.minX + sl.maxX) / 2, cz = (sl.minZ + sl.maxZ) / 2;
        const d = (e.x - cx) * (e.x - cx) + (e.z - cz) * (e.z - cz);
        if (d < bd) { bd = d; best = s; }
      }
      if (best >= 0) {
        this.slots[best].state = 'reinforced';
        this.applySlot(best);
      }
    }
    this.gun.setWorld(this.world.colliders, this.world.grid);
  }

  private applySlot(i: number): void {
    const s = this.slots[i];
    this.slotMeshes[i].visible = s.state === 'reinforced';
    const tag = this.wallTags[i];
    if (tag) {
      tag.sprite.visible = s.state === 'reinforced';
      if (s.state === 'reinforced') tag.set(`${Math.ceil(s.hp)}`, hpColor(s.hp, 50));
    }
    const wl = this.world.colliders;
    for (let k = wl.length - 1; k >= 0; k--) {
      if (wl[k].kind === 'box' && wl[k].name === s.name) wl.splice(k, 1);
    }
    if (s.state === 'reinforced') {
      wl.push({
        kind: 'box', name: s.name, group: 'wall',
        minX: s.minX, minY: s.minY, minZ: s.minZ,
        maxX: s.maxX, maxY: s.maxY, maxZ: s.maxZ,
      });
    }
    this.world.grid = buildGrid(wl);
  }

  setPlayerInteract(holding: boolean): void {
    this.interactHeld = holding;
  }

  private atkMat = new THREE.MeshBasicMaterial({ color: 0x2a6fd6, fog: true });
  private defMat = new THREE.MeshBasicMaterial({ color: 0xd06a1e, fog: true });
  private darkMat = new THREE.MeshBasicMaterial({ color: 0x222222, fog: true });

  private paintBody(i: number, side: Side): void {
    const m = side === 'atk' ? this.atkMat : this.defMat;
    const g = this.bodies[i];
    (g.children[1] as THREE.Mesh).material = m; // torso
    (g.children[2] as THREE.Mesh).material = m; // head
  }

  private buildBody(i: number, side: Side): void {
    const color = side === 'atk' ? 0x2a6fd6 : 0xd06a1e;
    const m = new THREE.MeshBasicMaterial({ color, fog: true });
    const dark = new THREE.MeshBasicMaterial({ color: 0x222222, fog: true });
    const g = new THREE.Group();
    const legs = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.8, 0.4), dark);
    legs.position.y = 0.4;
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.7, 0.35), m);
    torso.position.y = 1.15;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 8), m);
    head.position.y = 1.62;
    const gunM = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.1, 0.6), dark);
    gunM.position.set(0.25, 1.3, -0.35);
    g.add(legs, torso, head, gunM);
    const tag = makeTextSprite(0.85);
    tag.sprite.position.y = 2.1;
    g.add(tag.sprite);
    this.headTags[i] = tag;
    this.scene.add(g);
    this.bodies.push(g);
    this.guns.push(gunM);
  }

  private say(text: string): void {
    this.feed.push({ text, t: 5 });
    if (this.feed.length > 5) this.feed.shift();
    this.renderFeed();
  }

  private renderFeed(): void {
    this.feedEl.innerHTML = this.feed.map((f) => `<div>${f.text}</div>`).join('');
  }

  damageEntity(idx: number, dmg: number, head: boolean, by: string): void {
    const e = this.entities[idx];
    if (!e.alive || dmg <= 0) return;
    const [hp, alive] = hurt(e.hp, dmg);
    e.hp = hp;
    if (!alive) {
      e.alive = false;
      this.bodies[idx].rotation.x = -1.5; // fell over
      this.say(`${by} killed ${NAMES[idx]}${head ? ' (head)' : ''}`);
      const killer = NAMES.indexOf(by);
      if (killer >= 0) this.kills[killer]++;
      if (idx === 0) this.specIdx = this.firstAliveAlly();
    }
  }

  private firstAliveAlly(): number {
    for (let i = 1; i < 6; i++) {
      if (this.entities[i].alive && this.entities[i].side === this.st.playerSide) return i;
    }
    return 1;
  }

  nextSpectate(): void {
    for (let k = 1; k < 6; k++) {
      const i = ((this.specIdx + k - 1) % 5) + 1;
      if (this.entities[i].alive && this.entities[i].side === this.st.playerSide) {
        this.specIdx = i;
        return;
      }
    }
  }

  spectateCam(cam: THREE.Camera): void {
    const i = this.entities[this.specIdx]?.alive ? this.specIdx : this.firstAliveAlly();
    this.specIdx = i;
    const e = this.entities[i];
    const b = this.bots[i];
    cam.position.set(e.x, e.y + (e.crouch ? CFG.eyeCrouch : CFG.eyeStand), e.z);
    cam.rotation.order = 'YXZ';
    cam.rotation.y = b ? b.yaw : 0;
    cam.rotation.x = b ? b.pitch : 0;
  }

  // main calls this every frame with the player's sim (main owns player movement)
  syncPlayer(x: number, y: number, z: number, crouch: boolean): void {
    const e = this.entities[0];
    e.x = x; e.y = y; e.z = z; e.crouch = crouch;
    for (let i = 0; i < 6; i++) {
      const s = this.shootEnts[i];
      const q = this.entities[i];
      s.x = q.x; s.y = q.y; s.z = q.z; s.crouch = q.crouch; s.alive = q.alive;
    }
    // bot bodies follow (+ hp tags)
    for (let i = 1; i < 6; i++) {
      const q = this.entities[i];
      const g = this.bodies[i];
      g.position.set(q.x, q.y, q.z);
      const b = this.bots[i];
      if (b) g.rotation.y = b.yaw;
      g.scale.y = q.crouch ? 0.65 : 1;
      const tag = this.headTags[i];
      if (tag) {
        tag.sprite.visible = q.alive;
        // friends show through walls, enemies only in the open
        (tag.sprite.material as THREE.SpriteMaterial).depthTest = q.side === this.st.playerSide;
        if (q.alive && this.headShown[i] !== q.hp) {
          this.headShown[i] = q.hp;
          tag.set(`${Math.ceil(q.hp)}/300`, hpColor(q.hp, CFG.playerHp));
        }
      }
    }
  }

  applyBlast(x: number, y: number, z: number): void {
    this.gun.applyBlast(x, y, z); // boards + boom fx
    // entities (bots + you): shared falloff + wall blocking, one call
    for (let i = 0; i < 6; i++) {
      this.blastVictims[i].x = this.entities[i].x;
      this.blastVictims[i].y = this.entities[i].y + 0.9;
      this.blastVictims[i].z = this.entities[i].z;
    }
    const n = blastDamage(x, y, z, this.blastVictims, this.world.colliders, this.blastOut);
    for (let k = 0; k < n; k++) {
      const idx = this.blastOut[k].i;
      if (this.entities[idx].alive) this.damageEntity(idx, this.blastOut[k].dmg, false, 'frag');
    }
  }
  private blastVictims = [
    { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 },
    { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 },
  ];
  private blastOut = [
    { i: 0, dmg: 0 }, { i: 0, dmg: 0 }, { i: 0, dmg: 0 },
    { i: 0, dmg: 0 }, { i: 0, dmg: 0 }, { i: 0, dmg: 0 },
  ];

  update(dt: number): void {
    // round clock (counts from entities)
    let atkAlive = 0, defAlive = 0, atkIn = 0, defIn = 0;
    const site = this.activeSite();
    for (let i = 0; i < 6; i++) {
      const e = this.entities[i];
      if (!e.alive) continue;
      if (e.side === 'atk') atkAlive++; else defAlive++;
      const dx = e.x - site.x, dz = e.z - site.z;
      if (dx * dx + dz * dz < CFG.secureRadius * CFG.secureRadius && Math.abs(e.y - site.y) < 1.5) {
        if (e.side === 'atk') atkIn++; else defIn++;
      }
    }
    if (!this.over) {
      updateMatch(this.st, this.chosen, this.rng, dt, atkAlive, defAlive, atkIn, defIn);
      for (const ev of this.st.events) this.onEvent(ev);
      this.st.events.length = 0;
    }
    // active-site beacon: both teams see it through walls (orange attack, blue defend)
    {
      const atk = this.st.playerSide === 'atk';
      const color = atk ? 0xff9030 : 0x3a90ff;
      const s = this.activeSite();
      const show = this.st.phase !== 'matchEnd';
      for (let i = 0; i < this.beacons.length; i++) {
        const on = show && i === this.st.teamSite;
        this.beacons[i].group.visible = on;
        if (on) {
          this.beacons[i].set(s.x, s.y, s.z, color);
          this.beacons[i].tick(dt);
        }
      }
    }
    if (this.st.phase === 'action' && !this.over) {
      let mark = -1;
      if (atkAlive === 1 && defAlive >= 1) {
        for (let i = 0; i < 6; i++) if (this.entities[i].alive && this.entities[i].side === 'atk') { mark = i; break; }
      } else if (defAlive === 1 && atkAlive >= 1) {
        for (let i = 0; i < 6; i++) if (this.entities[i].alive && this.entities[i].side === 'def') { mark = i; break; }
      }
      if (mark >= 0) {
        const e = this.entities[mark];
        this.lastMark.position.set(e.x, e.y + 2.3, e.z);
        this.lastMark.rotation.y += dt * 3;
        this.lastMark.visible = true;
      } else this.lastMark.visible = false;
    } else this.lastMark.visible = false;
    this.botCtx.holdAttacks = this.st.phase === 'prep';
    this.botCtx.freeze = this.st.phase === 'prep';
    this.botCtx.teamSite = this.st.teamSite;

    // player F interact: reinforce (def/prep) tap, breach (atk/action) hold
    {
      const e = this.entities[0];
      const side = this.st.playerSide;
      const phase = this.st.phase;
      if (e.alive && this.interactHeld) {
        const now = performance.now();
        if (now - this.lastReinf >= 1000) {
          const made = tryReinforce(this.slots, side, phase, e.x, e.y, e.z);
          if (made) {
            this.lastReinf = now;
            this.applySlot(this.slots.indexOf(made));
            this.gun.setWorld(this.world.colliders, this.world.grid);
            this.say(`you reinforced ${made.name}`);
          }
        }
        const boom = stepBreach(this.slots, side, phase, true, e.x, e.y, e.z, dt);
        if (boom) {
          this.applySlot(this.slots.indexOf(boom));
          this.gun.setWorld(this.world.colliders, this.world.grid);
          this.say(`you breached ${boom.name}!`);
        }
      } else {
        // not holding: decay any progress
        stepBreach(this.slots, side, phase, false, e.x, e.y, e.z, dt);
      }
      const hint = e.alive ? interactHint(this.slots, side, phase, e.x, e.y, e.z) : '';
      if (hint !== this.lastHint) {
        this.lastHint = hint;
        this.interactEl.textContent = hint ? `[F] ${hint}` : '';
      }
    }

    // bots think + step + shoot (skip during roundEnd/matchEndvamo? let them stand down)
    const live = this.st.phase === 'prep' || this.st.phase === 'action';
    for (let i = 1; i < 6; i++) {
      const b = this.bots[i];
      if (!b || !this.entities[i].alive) continue;
      const cmd = this.cmds[i];
      if (live) {
        thinkBot(b, i, this.entities, this.botCtx, dt, cmd);
        const s = this.sims[i];
        this.inp.fwd = cmd.fwd; this.inp.back = cmd.back;
        this.inp.left = cmd.left; this.inp.right = cmd.right;
        this.inp.crouch = cmd.crouch; this.inp.jump = cmd.jump;
        this.inp.yaw = cmd.yaw; this.inp.sprint = false;
        stepPlayer(s, this.inp, Math.min(dt, 0.05), this.world.colliders, this.world.grid, 1);
        this.entities[i].x = s.x; this.entities[i].y = s.y; this.entities[i].z = s.z;
        this.entities[i].crouch = s.crouching;
        if (cmd.wantFire && this.st.phase === 'action') this.botShoot(i);
      }
    }
    this.hudT += dt;
    if (this.hudT > 0.25) { this.hudT = 0; this.renderHud(); }
    for (const f of this.feed) f.t -= dt;
  }

  private botShoot(i: number): void {
    const b = this.bots[i]!;
    const def = WEAPONS[b.gun];
    if (b.shotT > 0 || b.reloadT > 0) return;
    if (b.mag <= 0) { b.reloadT = def.reloadS; return; }
    b.mag--;
    b.shotT = 60 / def.rpm;
    const e = this.entities[i];
    const eyeY = e.y + (e.crouch ? 0.9 : 1.55);
    const cp = Math.cos(b.pitch);
    const dx = -Math.sin(b.yaw) * cp, dy = Math.sin(b.pitch), dz = -Math.cos(b.yaw) * cp;
    const n = fireHitscan(e.x, eyeY, e.z, dx, dy, dz, def, this.rng,
      (x, y, z, ax, ay, az, m) => raycast(this.world.colliders, x, y, z, ax, ay, az, m),
      [], this.pellets, (def.spreadHip + b.errCfg) / def.spreadHip, this.shootEnts, e.side);
    const mx = e.x + dx * 0.6, my = eyeY - 0.1, mz = e.z + dz * 0.6;
    const h0 = this.pellets[0];
    this.gun.fxTracer(mx, my, mz, h0.px, h0.py, h0.pz);
    for (let k = 0; k < n; k++) {
      const h = this.pellets[k];
      if (h.ent >= 0) {
        this.damageEntity(h.ent, h.dmg, h.head, NAMES[i]);
        if (h.ent === 0) this.say(`${NAMES[i]} hit you${h.head ? ' (head)' : ''}`);
      } else if (h.dist < 100) {
        this.gun.fxPuff(h.px, h.py, h.pz);
        this.gun.fxHole(h.px, h.py, h.pz, h.nx, h.ny, h.nz);
        this.chipWall(h.px, h.py, h.pz, h.dmg, NAMES[i]);
      }
    }
  }

  private onEvent(ev: string): void {
    if (ev === 'roundStart') {
      this.resetPositions();
      this.gun.refillNades();
      this.gun.refillAmmo();
      this.say(`Round ${this.st.round} — ${this.st.phase === 'prep' ? 'prep' : ''} site ${this.siteLetter()}`);
      this.endEl.style.display = 'none';
    } else if (ev === 'actionStart') {
      this.say('GO — attackers push!');
    } else if (ev.startsWith('atkWin') || ev.startsWith('defWin')) {
      const atk = ev.startsWith('atkWin');
      const winner: Side = atk ? 'atk' : 'def';
      if (winner === this.st.playerSide) this.playerScore++;
      const why = ev.split(':')[1];
      const how = why === 'elim' ? 'elimination' : why === 'secure' ? 'site secured' : why === 'time' ? 'time' : why;
      this.lastResult = `${atk ? 'ATTACKERS' : 'DEFENDERS'} take round ${this.st.round} (${how})`;
      this.say(`${this.lastResult} — ${this.st.atkWins}-${this.st.defWins} (you ${this.playerScore})`);
    } else if (ev === 'matchAtk' || ev === 'matchDef') {
      this.over = true;
      const played = this.st.atkWins + this.st.defWins;
      const youWon = this.playerScore * 2 > played;
      this.endEl.style.display = 'flex';
      this.endEl.querySelector('.msg')!.textContent =
        `${ev === 'matchAtk' ? 'ATTACKERS' : 'DEFENDERS'} take the match ${this.st.atkWins}-${this.st.defWins} — you ${youWon ? 'WIN' : 'LOSE'} (click to leave)`;
    }
  }

  private renderHud(): void {
    this.renderFeed(); // refresh expiry timers
    // loadout picker lives in the breaks (prep countdown + round end)
    paintLoadout(this.st.phase === 'prep' || this.st.phase === 'roundEnd', this.gun.loadout.primary, this.gun.loadout.secondary);
    const t = Math.max(0, this.st.t);
    const mm = Math.floor(t / 60), ss = Math.floor(t % 60).toString().padStart(2, '0');
    const phase = this.st.phase === 'prep' ? 'PREP' : this.st.phase === 'action' ? 'ACTION' : this.st.phase === 'roundEnd' ? 'ROUND' : 'MATCH';
    this.bannerEl.innerHTML =
      `<div>${phase} ${mm}:${ss} · R${this.st.round} · ATK ${this.st.atkWins} - ${this.st.defWins} DEF · site ${this.siteLetter()} (you: ${this.st.playerSide.toUpperCase()})</div>`;
    // big center card: countdown, GO, result
    const site = this.siteLetter();
    const you = this.st.playerSide === 'atk' ? 'YOU ATTACK' : 'YOU DEFEND';
    if (this.st.phase === 'prep') {
      this.centerEl.style.display = 'block';
      this.centerEl.textContent = `ROUND ${this.st.round}\n${you} · SITE ${site}\n${Math.ceil(t)}`;
    } else if (this.st.phase === 'action' && this.st.t > CFG.actionS - 2.5) {
      this.centerEl.style.display = 'block';
      this.centerEl.textContent = 'GO!';
    } else if (this.st.phase === 'roundEnd') {
      this.centerEl.style.display = 'block';
      this.centerEl.textContent = `${this.lastResult}\nnext round in ${Math.ceil(t)}`;
    } else {
      this.centerEl.style.display = 'none';
    }
    // secure bar
    if (this.st.phase === 'action' && this.st.secureT > 0.05) {
      this.secureEl.style.display = 'block';
      this.secureFill.style.width = `${Math.min(100, (this.st.secureT / CFG.secureTime) * 100)}%`;
    } else this.secureEl.style.display = 'none';
    // scoreboard (Tab)
    if (this.boardEl.style.display === 'block') {
      let html = '<div><b>TAB — scoreboard (click END to quit)</b></div>';
      for (let i = 0; i < 6; i++) {
        const e = this.entities[i];
        html += `<div>${NAMES[i]} [${e.side}] ${e.alive ? 'alive' : 'DEAD'} kills:${this.kills[i]}</div>`;
      }
      html += `<div id="endmatch" style="color:#f66;cursor:pointer;">END MATCH</div>`;
      this.boardEl.innerHTML = html;
      const btn = document.getElementById('endmatch');
      if (btn) btn.onclick = () => { this.over = true; this.endEl.style.display = 'flex'; this.endEl.querySelector('.msg')!.textContent = 'Match ended (click to leave)'; };
    }
  }

  setScoreboard(on: boolean): void {
    this.boardEl.style.display = on ? 'block' : 'none';
    if (on) this.renderHud();
  }

  setHudVisible(on: boolean): void {
    this.bannerEl.style.display = on ? 'block' : 'none';
    this.feedEl.style.display = on ? 'block' : 'none';
    if (!on) {
      this.centerEl.style.display = 'none'; this.secureEl.style.display = 'none'; this.boardEl.style.display = 'none'; this.endEl.style.display = 'none';
      paintLoadout(false, '', '');
    }
  }
}
