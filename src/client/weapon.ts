// M2: first-person gun, tracers, impact puffs, target boards. Pooled, no per-frame alloc.
import * as THREE from 'three';
import { CFG } from '../shared/config.js';
import { WEAPONS, GADGETS } from '../shared/weapons.js';
import { fireHitscan, hurt, makePelletPool, type PelletHit, type ShootEnt, type TargetBox } from '../shared/combat.js';
import { blastDamage, makeNade, stepNade, throwNade, type BlastOut, type Nade } from '../shared/grenade.js';
import { raycast, type Collider, type Grid } from '../shared/colliders.js';
import { getBind } from './bindings.js';

export type { ShootEnt };

const TRACERS = 24;
const PUFFS = 48;
const HOLES = 40;
const HOLE_LIFE = 10; // seconds a bullet hole stays

function puffTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(16, 16, 2, 16, 16, 16);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(c);
}

export class GunRig {
  cur = 'ar';
  ammo: Record<string, number> = {};
  reloading = false;
  lastHit = '';
  private reloadT = 0;
  private shotT = 0;       // time until next shot allowed
  private trigger = false;
  private triggerEdge = false;
  private kick = 0;        // pending pitch kick for main to apply
  private colliders: Collider[] = [];
  private grid: Grid | null = null;
  private targets: TargetBox[] = [];       // alive boards only (rebuilt on break/fix)
  private targetCenters: { x: number; y: number; z: number }[] = [];
  private boards: THREE.Mesh[] = [];
  private boardFlash: number[] = [];
  private boardHp: number[] = [];
  private boardBroken: boolean[] = [];
  private boardRespawn: number[] = [];
  private pellets = makePelletPool(8);

  // grenades: 2 live slots max, charges per life
  private nades: Nade[] = [makeNade(), makeNade()];
  private nadeMeshes: THREE.Mesh[] = [];
  private nadeCharges = GADGETS.frag.charges;
  // main flips this off while dead / frozen in prep: timers still run, trigger ignored
  acceptTrigger = true;
  // main sets this while typing chat: ignore weapon keys + trigger
  uiBlocked = false;
  // LAN mode hooks (null = local): server owns ammo/damage, we just do fx
  authoritative = false;
  hooks: {
    shot: (gunIdx: number, yaw: number, pitch: number) => void;
    reloadReq: () => void;
    usePri: () => void;
    useSec: () => void;
    setPri: (i: number) => void;
    setSec: (i: number) => void;
    nadeReq: () => void;
  } | null = null;
  private blastQ: { x: number; y: number; z: number }[] = [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }];
  private blastN = 0;
  private blastTmp: BlastOut[] = [{ i: 0, dmg: 0 }, { i: 0, dmg: 0 }, { i: 0, dmg: 0 }, { i: 0, dmg: 0 }];

  // ADS: right mouse aims (zoom + tighter spread)
  private adsHeld = false;
  private adsK = 0; // 0 hip .. 1 aimed

  private gun!: THREE.Group;
  private muzzle!: THREE.Object3D;
  private flash!: THREE.Mesh;
  private flashT = 0;
  private gunKick = 0; // viewmodel kickback 0..1
  private tracers: { line: THREE.Line; life: number }[] = [];
  private puffs: { s: THREE.Sprite; life: number }[] = [];
  private holes: { m: THREE.Mesh; age: number }[] = [];
  private hi = 0;
  private hitT = 0;
  private elHitm: HTMLElement | null = null;
  private elBar: HTMLElement | null = null;
  private lastBar = '';
  private labelCanvas!: HTMLCanvasElement;
  private labelTex!: THREE.CanvasTexture;

  constructor(private scene: THREE.Scene, private camera: THREE.Camera, el: HTMLElement) {
    for (const id of Object.keys(WEAPONS)) this.ammo[id] = WEAPONS[id].mag;
    this.buildView();
    this.buildFx();
    this.elHitm = document.getElementById('hitm');

    addEventListener('keydown', (e) => {
      if (this.uiBlocked) return;
      if (e.code === getBind('slotPri')) this.usePri();
      else if (e.code === getBind('slotSec')) this.useSec();
      else if (e.code === getBind('reload')) {
        if (this.hooks) this.hooks.reloadReq();
        else this.startReload();
      } else if (e.code === getBind('nade') && !e.repeat) {
        if (this.hooks) this.hooks.nadeReq();
        else this.throwFrag();
      }
    });
    el.addEventListener('mousedown', (e) => {
      if (document.pointerLockElement !== el) return;
      if (this.uiBlocked) return;
      if (e.button === 0) {
        if (!this.trigger) this.triggerEdge = true;
        this.trigger = true;
      } else if (e.button === 2) this.adsHeld = true;
    });
    addEventListener('mouseup', (e) => {
      if (e.button === 0) this.trigger = false;
      else if (e.button === 2) this.adsHeld = false;
    });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  setWorld(colliders: Collider[], grid: Grid): void {
    this.colliders = colliders;
    this.grid = grid;
  }

  // combined move-speed multiplier (gun weight + ADS slow)
  moveMul(): number {
    return this.def.movePenalty * (1 - this.adsK * 0.3);
  }

  // current spread multiplier for HUD/debug
  spreadMul(): number {
    return 1 - this.adsK * 0.6;
  }

  nadesLeft(): number { return this.nadeCharges; }
  refillAmmo(): void {
    for (const id of Object.keys(WEAPONS)) this.ammo[id] = WEAPONS[id].mag;
    this.reloading = false;
  }
  // server-authoritative ammo mirror (LAN)
  setServerAmmo(mag: number, nades: number, reloading: boolean): void {
    this.ammo[this.cur] = mag;
    this.nadeCharges = nades;
    if (reloading && !this.reloading) {
      this.reloading = true;
      this.reloadT = this.def.reloadS; // estimate; server corrects via mag
    } else if (!reloading) {
      this.reloading = false;
    }
  }
  refillNades(): void {
    this.nadeCharges = GADGETS.frag.charges;
    for (const n of this.nades) n.active = false;
    for (const m of this.nadeMeshes) m.visible = false;
  }

  // main drains blast positions after update() to damage the player
  drainBlasts(out: { x: number; y: number; z: number }[]): number {
    for (let i = 0; i < this.blastN; i++) {
      out[i].x = this.blastQ[i].x; out[i].y = this.blastQ[i].y; out[i].z = this.blastQ[i].z;
    }
    const n = this.blastN;
    this.blastN = 0;
    return n;
  }

  get def(): (typeof WEAPONS)[string] { return WEAPONS[this.cur]; }

  switch(id: string): void {
    if (this.cur === id) return;
    this.cur = id;
    this.reloading = false;
    this.triggerEdge = false;
    this.applyModelVis();
    this.drawLabel();
  }

  // glb viewmodels (loaded async; code boxes stay as fallback)
  private models: Record<string, { group: THREE.Group; muzzle: THREE.Object3D }> = {};
  private fallback!: THREE.Group;

  async loadModels(base: string): Promise<void> {
    if (Object.keys(this.models).length > 0) return; // once per session
    const files: Record<string, string> = {
      ar: 'rifle.glb', smg: 'smg.glb', shotgun: 'shotgun.glb',
      pistol: 'pistol.glb', machinepistol: 'machinepistol.glb',
    };
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
    for (const id of Object.keys(files)) {
      try {
        const gltf = await new GLTFLoader().loadAsync(`${base}/${files[id]}`);
        const group = new THREE.Group();
        group.add(gltf.scene);
        // fullbright: unlit materials keep the baked flat colors
        group.traverse((o) => {
          const m = o as THREE.Mesh;
          if (!m.isMesh) return;
          const old = m.material as THREE.Material | THREE.Material[];
          const first = (Array.isArray(old) ? old[0] : old) as unknown as { color?: THREE.Color };
          m.material = new THREE.MeshBasicMaterial({ color: first?.color?.clone() ?? new THREE.Color(0x888888), fog: false });
        });
        let muzzle: THREE.Object3D | null = null;
        group.traverse((o) => { if (o.name === 'Muzzle' && !muzzle) muzzle = o; });
        // center on the grip-ish origin the models were built around (already ~origin)
        group.visible = false;
        this.gun.add(group);
        this.models[id] = { group, muzzle: muzzle ?? group };
      } catch {
        // keep the code-box fallback for this gun
      }
    }
    this.applyModelVis();
  }

  private applyModelVis(): void {
    const m = this.models[this.cur];
    this.fallback.visible = !m;
    for (const id of Object.keys(this.models)) this.models[id].group.visible = id === this.cur;
    this.muzzle = m ? m.muzzle : this.fallbackMuzzle;
    // flash rides the active muzzle
    this.muzzle.add(this.flash);
    this.flash.position.set(0, 0, 0);
    this.flash.rotation.set(0, 0, 0);
  }
  private fallbackMuzzle!: THREE.Object3D;

  // loadout: one primary + one secondary carried together. 1/2 hold each.
  loadout = { primary: 'ar', secondary: 'pistol' };
  private PRIS = ['ar', 'smg', 'shotgun'];
  private SECS = ['pistol', 'machinepistol'];

  usePri(): void {
    this.switch(this.loadout.primary);
    if (this.hooks) this.hooks.usePri();
  }
  useSec(): void {
    this.switch(this.loadout.secondary);
    if (this.hooks) this.hooks.useSec();
  }
  setPri(i: number): void {
    if (i < 0 || i >= this.PRIS.length) return;
    this.loadout.primary = this.PRIS[i];
    this.switch(this.loadout.primary);
    if (this.hooks) this.hooks.setPri(i);
  }
  setSec(i: number): void {
    if (i < 0 || i >= this.SECS.length) return;
    this.loadout.secondary = this.SECS[i];
    this.switch(this.loadout.secondary);
    if (this.hooks) this.hooks.setSec(i);
  }

  startReload(): void {
    if (this.reloading || this.ammo[this.cur] === this.def.mag) return;
    this.reloading = true;
    this.reloadT = this.def.reloadS;
  }

  consumeKick(): number { const k = this.kick; this.kick = 0; return k; }

  // server-confirmed hit (LAN): text + marker flash
  noteHit(text: string): void {
    this.lastHit = text;
    if (this.elHitm) { this.elHitm.style.opacity = '1'; this.hitT = 0.15; }
  }

  hudLine(): string {
    const d = this.def;
    return `${d.name} ${this.ammo[this.cur]}/${d.mag}${this.reloading ? ' …reloading' : ''}`;
  }

  // --- targets: 3 boards behind the given attacker-side point ---
  private targetGroups: THREE.Group[] = [];

  clearTargets(): void {
    for (const g of this.targetGroups) this.scene.remove(g);
    this.targetGroups = [];
    this.boards = [];
    this.boardFlash = [];
    this.boardHp = [];
    this.boardBroken = [];
    this.boardRespawn = [];
    this.targetCenters = [];
    this.targets = [];
  }

  buildTargets(outColliders: Collider[], ox: number, oz: number): void {
    const xs = [ox - 4, ox, ox + 4];
    const postM = new THREE.MeshBasicMaterial({ color: 0x5a3a1a, fog: true });
    xs.forEach((x, i) => {
      const g = new THREE.Group();
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.1, 0.12), postM);
      post.position.set(x, 0.55, oz);
      const board = new THREE.Mesh(
        new THREE.BoxGeometry(0.7, 0.7, 0.06),
        new THREE.MeshBasicMaterial({ color: i === 1 ? 0xcc2222 : 0xeeeeee, fog: true }));
      board.position.set(x, 1.5, oz);
      board.rotation.x = 0;
      g.add(post, board);
      this.scene.add(g);
      this.targetGroups.push(g);
      this.boards.push(board);
      this.boardFlash.push(0);
      this.boardHp.push(100);
      this.boardBroken.push(false);
      this.boardRespawn.push(0);
      const bb = new THREE.Box3().setFromObject(board);
      this.targetCenters.push({
        x: (bb.min.x + bb.max.x) / 2, y: (bb.min.y + bb.max.y) / 2, z: (bb.min.z + bb.max.z) / 2 });
      outColliders.push({
        kind: 'box', name: `TargetPost_${i}`, group: 'prop',
        minX: x - 0.06, minY: 0, minZ: oz - 0.06, maxX: x + 0.06, maxY: 1.1, maxZ: oz + 0.06,
      });
    });
    this.rebuildTargets();
  }

  // alive boards only — rebuilt on break/respawn (rare, alloc ok)
  private rebuildTargets(): void {
    this.targets = [];
    for (let i = 0; i < this.boards.length; i++) {
      if (this.boardBroken[i]) continue;
      const bb = new THREE.Box3().setFromObject(this.boards[i]);
      this.targets.push({
        id: i, minX: bb.min.x, minY: bb.min.y, minZ: bb.min.z,
        maxX: bb.max.x, maxY: bb.max.y, maxZ: bb.max.z,
      });
    }
  }

  private damageBoard(i: number, dmg: number): void {
    if (this.boardBroken[i] || dmg <= 0) return;
    const [hp, alive] = hurt(this.boardHp[i], dmg);
    this.boardHp[i] = hp;
    if (!alive) {
      this.boardBroken[i] = true;
      this.boardRespawn[i] = 8;
      this.boards[i].rotation.x = -1.35; // knocked flat
      (this.boards[i].material as THREE.MeshBasicMaterial).color.setHex(0x552222);
      this.lastHit = 'BOARD DOWN (back in 8s)';
      this.rebuildTargets();
    }
  }

  private buildView(): void {
    this.gun = new THREE.Group();
    const dark = new THREE.MeshBasicMaterial({ color: 0x222222, fog: false });
    const mid = new THREE.MeshBasicMaterial({ color: 0x555555, fog: false });
    // fallback code-box gun (also the offline/no-glb look)
    this.fallback = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.13, 0.55), dark);
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.35, 8), mid);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.02, -0.42);
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.16, 0.09), dark);
    grip.position.set(0, -0.13, 0.08);
    grip.rotation.x = 0.3;
    this.fallback.add(body, barrel, grip);
    this.fallbackMuzzle = new THREE.Object3D();
    this.fallbackMuzzle.position.set(0, 0.02, -0.62);
    this.fallback.add(this.fallbackMuzzle);
    this.gun.add(this.fallback);
    this.muzzle = this.fallbackMuzzle;
    this.gun.position.set(0.24, -0.22, -0.45);
    // gun name plate: tiny canvas label on top of the body
    this.labelCanvas = document.createElement('canvas');
    this.labelCanvas.width = 256; this.labelCanvas.height = 48;
    this.labelTex = new THREE.CanvasTexture(this.labelCanvas);
    const plate = new THREE.Mesh(
      new THREE.PlaneGeometry(0.2, 0.0375),
      new THREE.MeshBasicMaterial({ map: this.labelTex, transparent: true, fog: false, depthWrite: false }));
    plate.position.set(0, 0.085, -0.02);
    plate.rotation.x = -0.45;
    this.gun.add(plate);
    this.drawLabel();
    this.flash = new THREE.Mesh(
      new THREE.PlaneGeometry(0.22, 0.22),
      new THREE.MeshBasicMaterial({ color: 0xffd34d, transparent: true, opacity: 0.95, fog: false, depthWrite: false }));
    this.flash.visible = false;
    this.gun.add(this.flash);
    this.camera.add(this.gun);
    this.applyModelVis();
  }

  private drawLabel(): void {
    const g = this.labelCanvas.getContext('2d')!;
    g.clearRect(0, 0, 256, 48);
    g.font = 'bold 30px monospace';
    g.textAlign = 'center';
    g.fillStyle = '#ffd34d';
    g.fillText(this.def.name.toUpperCase(), 128, 34);
    this.labelTex.needsUpdate = true;
  }

  private buildFx(): void {
    for (let i = 0; i < TRACERS; i++) {
      const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
      const line = new THREE.Line(geo, new THREE.LineBasicMaterial({
        color: 0xffe28a, transparent: true, opacity: 0, fog: false, depthWrite: false }));
      line.frustumCulled = false;
      this.scene.add(line);
      this.tracers.push({ line, life: 0 });
    }
    const tex = puffTexture();
    for (let i = 0; i < PUFFS; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({
        map: tex, color: 0xd8cfc0, transparent: true, opacity: 0, fog: false, depthWrite: false }));
      s.scale.set(0.25, 0.25, 1);
      this.scene.add(s);
      this.puffs.push({ s, life: 0 });
    }
    // bullet holes: dark dots stuck on the wall, gone after HOLE_LIFE
    const holeGeo = new THREE.CircleGeometry(0.022, 10);
    const holeMat = new THREE.MeshBasicMaterial({
      color: 0x141414, fog: true, polygonOffset: true, polygonOffsetFactor: -2 });
    for (let i = 0; i < HOLES; i++) {
      const m = new THREE.Mesh(holeGeo, holeMat);
      m.visible = false;
      this.scene.add(m);
      this.holes.push({ m, age: HOLE_LIFE });
    }
    this.elBar = document.getElementById('gunbar');
    // frag balls (2 max live)
    const ballGeo = new THREE.SphereGeometry(0.07, 10, 8);
    const ballMat = new THREE.MeshBasicMaterial({ color: 0x1a1a1a, fog: true });
    for (let i = 0; i < 2; i++) {
      const m = new THREE.Mesh(ballGeo, ballMat);
      m.visible = false;
      this.scene.add(m);
      this.nadeMeshes.push(m);
    }
    // scorch marks from booms (few, long life)
    const scorchGeo = new THREE.CircleGeometry(0.35, 12);
    const scorchMat = new THREE.MeshBasicMaterial({
      color: 0x0a0a0a, transparent: true, opacity: 0.75, fog: true,
      polygonOffset: true, polygonOffsetFactor: -2 });
    for (let i = 0; i < 6; i++) {
      const m = new THREE.Mesh(scorchGeo, scorchMat.clone());
      m.visible = false;
      m.rotation.x = -Math.PI / 2;
      this.scene.add(m);
      this.scorch.push({ m, age: 99 });
    }
  }

  private scorch: { m: THREE.Mesh; age: number }[] = [];
  private sci = 0;

  private throwFrag(): void {
    if (this.nadeCharges <= 0 || !this.grid) return;
    const n = this.nades.find((v) => !v.active);
    if (!n) return; // both balls still out
    this.nadeCharges--;
    this.camera.getWorldPosition(this.tmpM);
    this.tmpF.set(0, 0, -1).applyQuaternion(this.camera.getWorldQuaternion(this.tmpQ));
    throwNade(n, this.tmpM.x, this.tmpM.y, this.tmpM.z, this.tmpF.x, this.tmpF.y, this.tmpF.z);
  }

  // boom at (x,y,z): hurts boards, FX. Main separately hurts the player.
  applyBlast(x: number, y: number, z: number): void {
    const n = blastDamage(x, y, z, this.targetCenters, this.colliders, this.blastTmp);
    for (let k = 0; k < n; k++) this.damageBoard(this.blastTmp[k].i, this.blastTmp[k].dmg);
    // flash + dirt burst
    for (let k = 0; k < 8; k++) {
      const a = Math.random() * Math.PI * 2, r = 0.5 + Math.random() * 1.5;
      this.spawnPuff(x + Math.cos(a) * r, y + Math.random() * 1.2, z + Math.sin(a) * r);
    }
    this.lastHit = 'BOOM';
    // scorch on the ground below
    const down = raycast(this.colliders, x, y + 0.5, z, 0, -1, 0, 4);
    if (down.dist < 4) {
      const s = this.scorch[this.sci];
      this.sci = (this.sci + 1) % this.scorch.length;
      s.m.position.set(x, y + 0.5 - down.dist + 0.02, z);
      s.m.visible = true;
      s.age = 0;
      (s.m.material as THREE.MeshBasicMaterial).opacity = 0.75;
    }
  }

  private ti = 0;
  private pi = 0;
  private tmpM = new THREE.Vector3();
  private tmpF = new THREE.Vector3();
  private tmpQ = new THREE.Quaternion();

  // entities for player bullets (match sets these; no FF in solo)
  private entities: ShootEnt[] = [];
  private mySide: 'atk' | 'def' = 'atk';
  private onEntityHit: ((idx: number, dmg: number, head: boolean) => void) | null = null;
  // world hits (M6: someone may own that wall)
  onWorldHit: ((x: number, y: number, z: number, dmg: number) => void) | null = null;

  setEntities(list: ShootEnt[], mySide: 'atk' | 'def', onHit: (idx: number, dmg: number, head: boolean) => void): void {
    this.entities = list;
    this.mySide = mySide;
    this.onEntityHit = onHit;
  }

  // shared tracer/puff for bot shots
  fxTracer(ax: number, ay: number, az: number, bx: number, by: number, bz: number): void {
    this.spawnTracer(ax, ay, az, bx, by, bz);
  }
  fxPuff(x: number, y: number, z: number): void {
    this.spawnPuff(x, y, z);
  }
  fxHole(px: number, py: number, pz: number, nx: number, ny: number, nz: number): void {
    this.spawnHole(px, py, pz, nx, ny, nz);
  }

  private spawnTracer(ax: number, ay: number, az: number, bx: number, by: number, bz: number): void {
    const t = this.tracers[this.ti];
    this.ti = (this.ti + 1) % TRACERS;
    const p = t.line.geometry.getAttribute('position') as THREE.BufferAttribute;
    p.setXYZ(0, ax, ay, az);
    p.setXYZ(1, bx, by, bz);
    p.needsUpdate = true;
    (t.line.material as THREE.LineBasicMaterial).opacity = 0.9;
    t.life = 0.07;
  }

  private spawnPuff(x: number, y: number, z: number): void {
    const p = this.puffs[this.pi];
    this.pi = (this.pi + 1) % PUFFS;
    p.s.position.set(x, y, z);
    p.s.scale.set(0.18, 0.18, 1);
    (p.s.material as THREE.SpriteMaterial).opacity = 0.9;
    p.life = 0.25;
  }

  private spawnHole(px: number, py: number, pz: number, nx: number, ny: number, nz: number): void {
    const d = this.holes[this.hi];
    this.hi = (this.hi + 1) % HOLES;
    if (nx === 0 && ny === 0 && nz === 0) return; // sky/no surface: nothing to stick to
    d.m.position.set(px + nx * 0.006, py + ny * 0.006, pz + nz * 0.006);
    d.m.lookAt(px + nx, py + ny, pz + nz);
    d.m.visible = true;
    d.age = 0;
  }

  update(dt: number): void {
    // ADS blend + zoom + gun recentre
    const wantAds = this.adsHeld && !this.reloading ? 1 : 0;
    this.adsK += Math.max(-dt * 8, Math.min(dt * 8, wantAds - this.adsK));
    const cam = this.camera as THREE.PerspectiveCamera;
    const fov = 75 - this.adsK * 23;
    if (Math.abs(cam.fov - fov) > 0.05) { cam.fov = fov; cam.updateProjectionMatrix(); }
    this.gun.position.set(
      0.24 - this.adsK * 0.24,
      -0.22 + this.adsK * 0.072,
      -0.45 + this.adsK * 0.15 + this.gunKick * 0.07);

    // grenades
    if (this.grid) {
      for (let i = 0; i < this.nades.length; i++) {
        const n = this.nades[i];
        if (!n.active) continue;
        if (stepNade(n, dt, this.colliders, this.grid)) {
          if (this.blastN < this.blastQ.length) {
            this.blastQ[this.blastN].x = n.x;
            this.blastQ[this.blastN].y = n.y;
            this.blastQ[this.blastN].z = n.z;
            this.blastN++;
          }
          this.applyBlast(n.x, n.y, n.z);
        }
        this.nadeMeshes[i].position.set(n.x, n.y, n.z);
        this.nadeMeshes[i].visible = n.active;
      }
    }
    // board respawn
    for (let i = 0; i < this.boards.length; i++) {
      if (!this.boardBroken[i]) continue;
      this.boardRespawn[i] -= dt;
      if (this.boardRespawn[i] <= 0) {
        this.boardBroken[i] = false;
        this.boardHp[i] = 100;
        this.boards[i].rotation.x = 0;
        (this.boards[i].material as THREE.MeshBasicMaterial).color.setHex(i === 1 ? 0xcc2222 : 0xeeeeee);
        this.rebuildTargets();
      }
    }
    // scorch fade after 30s
    for (const s of this.scorch) {
      if (!s.m.visible) continue;
      s.age += dt;
      if (s.age > 30) s.m.visible = false;
    }
    if (this.reloading) {
      this.reloadT -= dt;
      if (this.reloadT <= 0) {
        this.reloading = false;
        if (!this.authoritative) this.ammo[this.cur] = this.def.mag;
      }
    }
    this.shotT -= dt;
    // trigger
    if (!this.acceptTrigger) { this.trigger = false; this.triggerEdge = false; }
    if (!this.reloading && this.trigger && this.shotT <= 0) {
      if (this.def.auto || this.triggerEdge) this.shoot();
    }
    this.triggerEdge = false;

    // fx decay (fixed pools, no alloc)
    for (const t of this.tracers) {
      if (t.life > 0) {
        t.life -= dt;
        if (t.life <= 0) (t.line.material as THREE.LineBasicMaterial).opacity = 0;
      }
    }
    for (const p of this.puffs) {
      if (p.life > 0) {
        p.life -= dt;
        const m = p.s.material as THREE.SpriteMaterial;
        m.opacity = Math.max(0, p.life / 0.25) * 0.9;
        const s = p.s.scale.x + dt * 1.5;
        p.s.scale.set(s, s, 1);
      }
    }
    if (this.flashT > 0) {
      this.flashT -= dt;
      if (this.flashT <= 0) this.flash.visible = false;
    }
    if (this.gunKick > 0) {
      this.gunKick = Math.max(0, this.gunKick - dt * 8);
    }
    for (let i = 0; i < this.boards.length; i++) {
      if (this.boardFlash[i] > 0) {
        this.boardFlash[i] -= dt;
        if (this.boardFlash[i] <= 0) {
          (this.boards[i].material as THREE.MeshBasicMaterial).color.setHex(i === 1 ? 0xcc2222 : 0xeeeeee);
        }
      }
    }
    if (this.hitT > 0) {
      this.hitT -= dt;
      if (this.hitT <= 0 && this.elHitm) this.elHitm.style.opacity = '0';
    }
    for (const h of this.holes) {
      if (!h.m.visible) continue;
      h.age += dt;
      if (h.age >= HOLE_LIFE) h.m.visible = false;
    }
    // bottom bar: gun + ammo + frags, only touch DOM when it changes
    const r = this.reloading ? ` …${Math.max(0, this.reloadT).toFixed(1)}s` : '';
    const bar = `${this.def.name.toUpperCase()}   ${this.ammo[this.cur]} / ${this.def.mag}${r}   ·   FRAG ${this.nadeCharges}`;
    if (bar !== this.lastBar) {
      this.lastBar = bar;
      if (this.elBar) this.elBar.textContent = bar;
    }
  }

  private shoot(): void {
    const d = this.def;
    if (this.ammo[this.cur] <= 0) {
      if (this.hooks) this.hooks.reloadReq();
      else this.startReload();
      return;
    }
    if (this.authoritative) {
      // server owns damage/ammo: fx now, this shot's verdict comes back later
      if (this.hooks) {
        this.camera.getWorldPosition(this.tmpM);
        this.tmpF.set(0, 0, -1).applyQuaternion(this.camera.getWorldQuaternion(this.tmpQ));
        this.hooks.shot(
          ['ar', 'smg', 'shotgun', 'pistol', 'machinepistol'].indexOf(this.cur),
          Math.atan2(-this.tmpF.x, -this.tmpF.z), Math.asin(this.tmpF.y));
      }
    } else {
      this.ammo[this.cur]--;
    }
    this.shotT = 60 / d.rpm;

    // eye + forward from camera (reused temps)
    this.camera.getWorldPosition(this.tmpM);
    this.tmpF.set(0, 0, -1).applyQuaternion(this.camera.getWorldQuaternion(this.tmpQ));
    const ox = this.tmpM.x, oy = this.tmpM.y, oz = this.tmpM.z;

    const n = fireHitscan(ox, oy, oz, this.tmpF.x, this.tmpF.y, this.tmpF.z,
      d, Math.random,
      (x, y, z, dx, dy, dz, m) => raycast(this.colliders, x, y, z, dx, dy, dz, m),
      this.targets, this.pellets, this.spreadMul(), this.entities, this.mySide);

    // muzzle world pos for tracer start
    this.muzzle.getWorldPosition(this.tmpM);
    let endX = ox + this.tmpF.x * 30, endY = oy + this.tmpF.y * 30, endZ = oz + this.tmpF.z * 30;
    for (let i = 0; i < n; i++) {
      const h: PelletHit = this.pellets[i];
      if (h.ent >= 0) {
        if (this.onEntityHit) this.onEntityHit(h.ent, h.dmg, h.head);
        this.lastHit = h.head ? `HEADSHOT ${Math.round(h.dmg)}` : `HIT ${h.dist.toFixed(0)}m ${Math.round(h.dmg)}`;
        if (this.elHitm) { this.elHitm.style.opacity = '1'; this.hitT = 0.12; }
      } else if (h.targetId >= 0) {
        this.boardFlash[h.targetId] = 0.12;
        (this.boards[h.targetId].material as THREE.MeshBasicMaterial).color.setHex(0xffffff);
        this.damageBoard(h.targetId, h.dmg);
        this.spawnHole(h.px, h.py, h.pz, h.nx, h.ny, h.nz);
        if (!this.boardBroken[h.targetId]) this.lastHit = `HIT board ${h.dist.toFixed(0)}m ${Math.round(h.dmg)}dmg`;
        if (this.elHitm) { this.elHitm.style.opacity = '1'; this.hitT = 0.12; }
      } else if (h.dist < 100) {
        this.spawnPuff(h.px, h.py, h.pz);
        this.spawnHole(h.px, h.py, h.pz, h.nx, h.ny, h.nz);
        if (this.onWorldHit) this.onWorldHit(h.px, h.py, h.pz, h.dmg);
      }
      if (i === 0) { endX = h.px; endY = h.py; endZ = h.pz; }
    }
    this.spawnTracer(this.tmpM.x, this.tmpM.y, this.tmpM.z, endX, endY, endZ);

    // flash + kick (tiny, no pattern; ADS steadies it)
    this.flash.visible = true;
    this.flash.rotation.z = Math.random() * Math.PI;
    this.flashT = 0.045;
    this.gunKick = 1;
    this.kick += d.kick * (1 - this.adsK * 0.4);
  }
}
