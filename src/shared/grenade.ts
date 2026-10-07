// Shared frag logic: throw, bounce, fuse, blast with wall blocking.
// Renderer-free. Server (M5) will step this at fixed tick; client previews in M3.
import { GADGETS } from './weapons.js';
import { queryBox, rampHeightAt, raycast, type Collider, type Grid } from './colliders.js';

export interface Nade {
  active: boolean;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  t: number; // fuse left
}

export function makeNade(): Nade {
  return { active: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, t: 0 };
}

const R = 0.07;          // ball radius
const GRAV = -12.0;
const BOUNCE = 0.45;     // keep 45% of hit-axis speed
const FRICTION = 0.7;    // keep 70% of slide speed on bounce
const STOP = 0.6;        // below this speed: rest

const _q: number[] = [];
for (let i = 0; i < 64; i++) _q.push(0);

function blockedAt(list: Collider[], grid: Grid, x: number, y: number, z: number): boolean {
  const n = queryBox(grid, list, _q, x - R, y - R, z - R, x + R, y + R, z + R);
  for (let k = 0; k < n; k++) {
    const c = list[_q[k]];
    if (c.kind === 'ramp') continue; // ramps handled as surfaces below
    if (x + R > c.minX && x - R < c.maxX &&
        y + R > c.minY && y - R < c.maxY &&
        z + R > c.minZ && z - R < c.maxZ) return true;
  }
  return false;
}

// Steps one live nade. Returns true on the tick it explodes.
export function stepNade(n: Nade, dt: number, list: Collider[], grid: Grid): boolean {
  if (!n.active) return false;
  n.t -= dt;
  if (n.t <= 0) { n.active = false; return true; }

  n.vy += GRAV * dt;

  // X
  {
    const nx = n.x + n.vx * dt;
    if (!blockedAt(list, grid, nx, n.y, n.z)) n.x = nx;
    else { n.vx = -n.vx * BOUNCE; n.vy *= FRICTION; n.vz *= FRICTION; }
  }
  // Z
  {
    const nz = n.z + n.vz * dt;
    if (!blockedAt(list, grid, n.x, n.y, nz)) n.z = nz;
    else { n.vz = -n.vz * BOUNCE; n.vx *= FRICTION; n.vy *= FRICTION; }
  }
  // Y (boxes)
  {
    const ny = n.y + n.vy * dt;
    if (!blockedAt(list, grid, n.x, ny, n.z)) n.y = ny;
    else {
      if (n.vy < 0) {
        n.vy = -n.vy * BOUNCE;
        n.vx *= FRICTION; n.vz *= FRICTION;
        if (Math.abs(n.vy) < STOP) n.vy = 0;
      } else n.vy = 0;
    }
  }
  // ramp surface rest/bounce (low edge of stairs etc.)
  {
    const nn = queryBox(grid, list, _q, n.x - R, n.y - R - 0.1, n.z - R, n.x + R, n.y + R, n.z + R);
    for (let k = 0; k < nn; k++) {
      const c = list[_q[k]];
      if (c.kind !== 'ramp') continue;
      const h = rampHeightAt(c, n.x, n.z);
      if (Number.isNaN(h)) continue;
      if (n.y - R < h && n.y > h - 0.5) {
        n.y = h + R;
        if (n.vy < 0) {
          n.vy = -n.vy * BOUNCE;
          n.vx *= FRICTION; n.vz *= FRICTION;
          if (Math.abs(n.vy) < STOP) n.vy = 0;
        }
      }
    }
  }
  if (n.y < -30) { n.active = false; return true; } // fell out: pop harmlessly
  return false;
}

export function throwNade(n: Nade, px: number, py: number, pz: number,
  dx: number, dy: number, dz: number): void {
  const g = GADGETS.frag;
  n.active = true;
  n.x = px + dx * 0.5; n.y = py + dy * 0.5; n.z = pz + dz * 0.5;
  const sp = 12;
  n.vx = dx * sp; n.vy = dy * sp + 2.5; n.vz = dz * sp;
  n.t = g.fuseS;
}

export interface BlastVictim { x: number; y: number; z: number; }
export interface BlastOut { i: number; dmg: number; }

// Area damage with wall blocking. Fills out, returns count. No alloc.
export function blastDamage(bx: number, by: number, bz: number,
  victims: BlastVictim[], list: Collider[],
  out: BlastOut[]): number {
  const g = GADGETS.frag;
  let n = 0;
  for (let i = 0; i < victims.length; i++) {
    const v = victims[i];
    const dx = v.x - bx, dy = v.y - by, dz = v.z - bz;
    const d = Math.hypot(dx, dy, dz);
    if (d > g.radius) continue;
    // blocked by a wall between boom and victim?
    const inv = 1 / (d || 1);
    const r = raycast(list, bx, by, bz, dx * inv, dy * inv, dz * inv, d);
    if (r.dist < d - 0.3) continue; // wall ate it
    out[n++] = { i, dmg: Math.round(g.damage * (1 - d / g.radius)) };
  }
  return n;
}
