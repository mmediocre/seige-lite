// Pure hitscan: no rendering, no DOM. Shared by solo + server (M4/M5).
// Caller supplies: rng, world raycast, and target boxes (boards now, players M3).
import { CFG } from './config.js';
import type { WeaponDef } from './weapons.js';

export interface TargetBox {
  id: number;
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
}

// A live body for hitscan (bots now, players on the server later).
export interface ShootEnt {
  x: number; y: number; z: number; // feet
  crouch: boolean; alive: boolean;
  side: 'atk' | 'def';
}

export interface PelletHit {
  dx: number; dy: number; dz: number; // fired direction (spread applied)
  dist: number;                        // metres to stop point
  px: number; py: number; pz: number;  // stop point
  nx: number; ny: number; nz: number;  // surface normal at stop point (faces shooter)
  targetId: number;                    // -1 = none, else TargetBox.id
  ent: number;                         // -1 = none, else entity index (M4 bots, M5 players)
  head: boolean;                       // entity headshot
  dmg: number;                         // falloff damage for this pellet
}

export interface WorldHit { dist: number; idx: number; nx: number; ny: number; nz: number }
export type WorldRay = (ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number, maxDist: number) => WorldHit;

// Deterministic RNG for tests (client passes Math.random).
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function damageAt(def: WeaponDef, dist: number): number {
  if (dist <= def.falloffNear) return def.damage;
  if (dist >= def.falloffFar) return def.minDamage;
  const t = (dist - def.falloffNear) / (def.falloffFar - def.falloffNear);
  return def.damage + t * (def.minDamage - def.damage);
}

// Slab test vs one AABB. Returns dist or Infinity.
function rayBox(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number,
  ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number): number {
  let t0 = 0, t1 = maxDist;
  // X
  if (dx === 0) { if (ox < minX || ox > maxX) return Infinity; }
  else {
    let ta = (minX - ox) / dx, tb = (maxX - ox) / dx;
    if (ta > tb) { const q = ta; ta = tb; tb = q; }
    if (ta > t0) t0 = ta; if (tb < t1) t1 = tb;
    if (t0 > t1) return Infinity;
  }
  // Y
  if (dy === 0) { if (oy < minY || oy > maxY) return Infinity; }
  else {
    let ta = (minY - oy) / dy, tb = (maxY - oy) / dy;
    if (ta > tb) { const q = ta; ta = tb; tb = q; }
    if (ta > t0) t0 = ta; if (tb < t1) t1 = tb;
    if (t0 > t1) return Infinity;
  }
  // Z
  if (dz === 0) { if (oz < minZ || oz > maxZ) return Infinity; }
  else {
    let ta = (minZ - oz) / dz, tb = (maxZ - oz) / dz;
    if (ta > tb) { const q = ta; ta = tb; tb = q; }
    if (ta > t0) t0 = ta; if (tb < t1) t1 = tb;
    if (t0 > t1) return Infinity;
  }
  return t0 >= 0 ? t0 : Infinity;
}

const MAX_DIST = 120;

// Fires def.pellets rays. Fills `out`, returns pellet count. No allocation.
export function fireHitscan(
  ox: number, oy: number, oz: number,
  fx: number, fy: number, fz: number,
  def: WeaponDef, rng: () => number,
  world: WorldRay, targets: TargetBox[], out: PelletHit[],
  spreadMul = 1, entities: ShootEnt[] | null = null, mySide: 'atk' | 'def' | null = null,
): number {
  // basis around forward (no alloc: locals only)
  let rx = -fz, ry = 0, rz = fx; // forward x up(0,1,0)
  let rl = Math.hypot(rx, ry, rz);
  if (rl < 1e-6) { rx = 1; ry = 0; rz = 0; rl = 1; }
  rx /= rl; ry /= rl; rz /= rl;
  // up = right x forward
  const ux = ry * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - ry * fx;

  for (let i = 0; i < def.pellets; i++) {
    // random point in disc (uniform), radius tan(spread)
    const a = rng() * Math.PI * 2;
    const rr = Math.sqrt(rng()) * Math.tan(def.spreadHip * spreadMul);
    const ca = Math.cos(a) * rr, sa = Math.sin(a) * rr;
    let dx = fx + rx * ca + ux * sa;
    let dy = fy + ry * ca + uy * sa;
    let dz = fz + rz * ca + uz * sa;
    const dl = Math.hypot(dx, dy, dz);
    dx /= dl; dy /= dl; dz /= dl;

    const w = world(ox, oy, oz, dx, dy, dz, MAX_DIST);
    let best = w.dist, targetId = -1, ent = -1, head = false;
    let nx = w.nx, ny = w.ny, nz = w.nz;
    for (let t = 0; t < targets.length; t++) {
      const b = targets[t];
      const d = rayBox(b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ,
        ox, oy, oz, dx, dy, dz, Math.min(best, MAX_DIST));
      if (d < best) { best = d; targetId = b.id; ent = -1; nx = -dx; ny = -dy; nz = -dz; }
    }
    if (entities) {
      for (let e = 0; e < entities.length; e++) {
        const p = entities[e];
        if (!p.alive || (mySide && p.side === mySide)) continue; // no friendly fire
        const hit = rayVsEntity(ox, oy, oz, dx, dy, dz, p.x, p.y, p.z, p.crouch, Math.min(best, MAX_DIST));
        if (hit && hit.dist < best) {
          best = hit.dist; ent = e; targetId = -1; head = hit.head;
          nx = -dx; ny = -dy; nz = -dz;
        }
      }
    }
    if (best === Infinity || best > MAX_DIST) best = MAX_DIST;
    const h = out[i];
    h.dx = dx; h.dy = dy; h.dz = dz;
    h.dist = best;
    h.px = ox + dx * best; h.py = oy + dy * best; h.pz = oz + dz * best;
    h.nx = nx; h.ny = ny; h.nz = nz;
    h.targetId = targetId;
    h.ent = ent;
    h.head = head;
    let dmg = targetId >= 0 || ent >= 0 || best < MAX_DIST ? damageAt(def, best) : 0;
    if (head) dmg *= CFG.headshotMul;
    h.dmg = dmg;
  }
  return def.pellets;
}
export function makePelletPool(n: number): PelletHit[] {
  const a: PelletHit[] = [];
  for (let i = 0; i < n; i++) a.push({ dx: 0, dy: 0, dz: 0, dist: 0, px: 0, py: 0, pz: 0, nx: 0, ny: 1, nz: 0, targetId: -1, ent: -1, head: false, dmg: 0 });
  return a;
}

// Shared damage: returns [hpLeft, alive]. Used by boards, players, bots alike.
export function hurt(hp: number, dmg: number): [number, boolean] {
  const left = hp - dmg;
  return [left < 0 ? 0 : left, left > 0];
}

// Ray vs a player-like body: capsule body + sphere head.
// (px,py,pz) = feet. Returns dist + head flag, or null. No alloc (out param).
export interface EntityHit { dist: number; head: boolean }
const _eh: EntityHit = { dist: 0, head: false };

function raySphere(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
  cx: number, cy: number, cz: number, r: number, maxDist: number): number {
  const lx = cx - ox, ly = cy - oy, lz = cz - oz;
  const t = lx * dx + ly * dy + lz * dz;
  if (t < 0 || t > maxDist) return Infinity;
  const d2 = lx * lx + ly * ly + lz * lz - t * t;
  if (d2 > r * r) return Infinity;
  const hit = t - Math.sqrt(r * r - d2);
  return hit >= 0 ? hit : Infinity;
}

export function rayVsEntity(
  ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
  px: number, py: number, pz: number, crouch: boolean, maxDist: number,
): EntityHit | null {
  const h = crouch ? 1.1 : 1.8;
  // head sphere (eye-ish top)
  const hx = px, hy = py + h - 0.25, hz = pz;
  const dh = raySphere(ox, oy, oz, dx, dy, dz, hx, hy, hz, 0.25, maxDist);
  // body box (capsule approx, stops at the neck so heads count)
  const db = rayBox(px - 0.35, py, pz - 0.35, px + 0.35, py + h - 0.45, pz + 0.35,
    ox, oy, oz, dx, dy, dz, maxDist);
  if (dh === Infinity && db === Infinity) return null;
  if (dh <= db) { _eh.dist = dh; _eh.head = true; }
  else { _eh.dist = db; _eh.head = false; }
  return _eh;
}
