// Collider storage + queries. Renderer-free: plain numbers only.
// Boxes: centre = node pos, size = node scale (unit-cube convention).
// Ramp: wedge described as a heightfield strip + AABB (walkable 45° slope).
import { CFG } from './config.js';
import type { V3 } from './math.js';

export type Group = 'wall' | 'floor' | 'prop' | 'other' | 'ramp';

export interface BoxC {
  kind: 'box'; name: string; group: Group;
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
}
export interface RampC {
  kind: 'ramp'; name: string; group: 'ramp';
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
  runAxis: 'x' | 'z';
  runLow: number; runHigh: number; // world coord along run axis
  yLow: number; yHigh: number;
  slopeDeg: number;
}
export type Collider = BoxC | RampC;

export interface Grid {
  cell: number;
  ox: number; oy: number; oz: number; // origin
  nx: number; ny: number; nz: number;
  cells: number[][];  // collider indices per cell
  stamp: Int32Array;  // dedupe stamps
  cur: number;
}

export function buildGrid(list: Collider[], cell = CFG.gridCell): Grid {
  let mnx = 1e9, mny = 1e9, mnz = 1e9, mxx = -1e9, mxy = -1e9, mxz = -1e9;
  for (const c of list) {
    if (c.minX < mnx) mnx = c.minX; if (c.minY < mny) mny = c.minY; if (c.minZ < mnz) mnz = c.minZ;
    if (c.maxX > mxx) mxx = c.maxX; if (c.maxY > mxy) mxy = c.maxY; if (c.maxZ > mxz) mxz = c.maxZ;
  }
  mnx -= 1; mny -= 1; mnz -= 1; mxx += 1; mxy += 1; mxz += 1;
  const nx = Math.max(1, Math.ceil((mxx - mnx) / cell));
  const ny = Math.max(1, Math.ceil((mxy - mny) / cell));
  const nz = Math.max(1, Math.ceil((mxz - mnz) / cell));
  const cells: number[][] = new Array(nx * ny * nz);
  for (let i = 0; i < cells.length; i++) cells[i] = [];
  const g: Grid = { cell, ox: mnx, oy: mny, oz: mnz, nx, ny, nz, cells, stamp: new Int32Array(list.length), cur: 1 };
  for (let i = 0; i < list.length; i++) insert(g, list, i);
  return g;
}

function insert(g: Grid, list: Collider[], i: number): void {
  const c = list[i];
  const x0 = Math.max(0, Math.floor((c.minX - g.ox) / g.cell));
  const y0 = Math.max(0, Math.floor((c.minY - g.oy) / g.cell));
  const z0 = Math.max(0, Math.floor((c.minZ - g.oz) / g.cell));
  const x1 = Math.min(g.nx - 1, Math.floor((c.maxX - g.ox) / g.cell));
  const y1 = Math.min(g.ny - 1, Math.floor((c.maxY - g.oy) / g.cell));
  const z1 = Math.min(g.nz - 1, Math.floor((c.maxZ - g.oz) / g.cell));
  for (let x = x0; x <= x1; x++)
    for (let y = y0; y <= y1; y++)
      for (let z = z0; z <= z1; z++)
        g.cells[(x * g.ny + y) * g.nz + z].push(i);
}

// Fill `out` with candidate indices overlapping a box. Returns count. No alloc.
export function queryBox(g: Grid, list: Collider[], out: number[],
  minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): number {
  const x0 = Math.max(0, Math.floor((minX - g.ox) / g.cell));
  const y0 = Math.max(0, Math.floor((minY - g.oy) / g.cell));
  const z0 = Math.max(0, Math.floor((minZ - g.oz) / g.cell));
  const x1 = Math.min(g.nx - 1, Math.floor((maxX - g.ox) / g.cell));
  const y1 = Math.min(g.ny - 1, Math.floor((maxY - g.oy) / g.cell));
  const z1 = Math.min(g.nz - 1, Math.floor((maxZ - g.oz) / g.cell));
  g.cur++;
  let n = 0;
  for (let x = x0; x <= x1; x++)
    for (let y = y0; y <= y1; y++)
      for (let z = z0; z <= z1; z++) {
        const arr = g.cells[(x * g.ny + y) * g.nz + z];
        for (let k = 0; k < arr.length; k++) {
          const i = arr[k];
          if (g.stamp[i] === g.cur) continue;
          g.stamp[i] = g.cur;
          out[n++] = i;
        }
      }
  void list;
  return n;
}

export function boxOverlaps(b: BoxC,
  minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): boolean {
  return minX < b.maxX && maxX > b.minX &&
         minY < b.maxY && maxY > b.minY &&
         minZ < b.maxZ && maxZ > b.minZ;
}

// Height of ramp surface at (x,z). NaN when outside strip.
export function rampHeightAt(r: RampC, x: number, z: number): number {
  const loX = r.minX - 0.05, hiX = r.maxX + 0.05;
  const loZ = r.minZ - 0.05, hiZ = r.maxZ + 0.05;
  if (x < loX || x > hiX || z < loZ || z > hiZ) return NaN;
  const along = r.runAxis === 'x' ? x : z;
  const t = (along - r.runLow) / (r.runHigh - r.runLow);
  if (t < -0.05 || t > 1.05) return NaN;
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return r.yLow + c * (r.yHigh - r.yLow);
}

// Same but clamps to the nearest point: the wedge's height at its faces.
// Used for solidity (low edge ~= ground = passable, tall faces = walls).
export function rampHeightClamped(r: RampC, x: number, z: number): number {
  const cx = x < r.minX ? r.minX : x > r.maxX ? r.maxX : x;
  const cz = z < r.minZ ? r.minZ : z > r.maxZ ? r.maxZ : z;
  const along = r.runAxis === 'x' ? cx : cz;
  const t = (along - r.runLow) / (r.runHigh - r.runLow);
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return r.yLow + c * (r.yHigh - r.yLow);
}

// Hitscan ray vs boxes (+ ramp as box for M1). Returns dist or Infinity + face normal. No alloc.
export function raycast(list: Collider[], ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number, maxDist: number): { dist: number; idx: number; nx: number; ny: number; nz: number } {
  let best = maxDist, bi = -1, bnx = 0, bny = 0, bnz = 0;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    // slab test, tracking which face we entered through (for decals)
    let t0 = 0, t1 = best, nx = 0, ny = 0, nz = 0;
    // X
    if (dx === 0) { if (ox < c.minX || ox > c.maxX) continue; }
    else {
      let ta = (c.minX - ox) / dx, tb = (c.maxX - ox) / dx;
      const s = dx > 0 ? -1 : 1;
      if (ta > tb) { const q = ta; ta = tb; tb = q; }
      if (ta > t0) { t0 = ta; nx = s; ny = 0; nz = 0; } if (tb < t1) t1 = tb;
      if (t0 > t1) continue;
    }
    // Y
    if (dy === 0) { if (oy < c.minY || oy > c.maxY) continue; }
    else {
      let ta = (c.minY - oy) / dy, tb = (c.maxY - oy) / dy;
      const s = dy > 0 ? -1 : 1;
      if (ta > tb) { const q = ta; ta = tb; tb = q; }
      if (ta > t0) { t0 = ta; nx = 0; ny = s; nz = 0; } if (tb < t1) t1 = tb;
      if (t0 > t1) continue;
    }
    // Z
    if (dz === 0) { if (oz < c.minZ || oz > c.maxZ) continue; }
    else {
      let ta = (c.minZ - oz) / dz, tb = (c.maxZ - oz) / dz;
      const s = dz > 0 ? -1 : 1;
      if (ta > tb) { const q = ta; ta = tb; tb = q; }
      if (ta > t0) { t0 = ta; nx = 0; ny = 0; nz = s; } if (tb < t1) t1 = tb;
      if (t0 > t1) continue;
    }
    if (t0 < best && t0 >= 0) { best = t0; bi = i; bnx = nx; bny = ny; bnz = nz; }
  }
  return { dist: bi >= 0 ? best : Infinity, idx: bi, nx: bnx, ny: bny, nz: bnz };
}

export type { V3 };
