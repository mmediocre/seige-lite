// Auto waypoint graph from colliders (no hand-placed points: new maps just work).
// Layers: ground feet + upstairs feet + ramp chain. BFS paths. Built once per map.
import { CFG } from './config.js';
import { isFree } from './sim.js';
import { queryBox, rampHeightAt, type Collider, type Grid } from './colliders.js';

export interface NavNode { x: number; y: number; z: number }
export interface NavGraph {
  nodes: NavNode[];
  adj: number[][];
  minX: number; minZ: number; step: number; nx: number; nz: number;
  cellNode: Int32Array; // grid cell -> node idx (ground+upstairs layers packed per layer)
}

const _q: number[] = [];
for (let i = 0; i < 128; i++) _q.push(0);

// solid floor underfoot within step reach?
function supported(list: Collider[], grid: Grid, x: number, y: number, z: number): boolean {
  const n = queryBox(grid, list, _q, x - 0.3, y - 0.65, z - 0.3, x + 0.3, y + 0.05, z + 0.3);
  for (let k = 0; k < n; k++) {
    const c = list[_q[k]];
    if (c.kind === 'ramp') {
      const h = rampHeightAt(c, x, z);
      if (!Number.isNaN(h) && h <= y + 0.05 && h >= y - 0.65) return true;
    } else {
      if (c.maxX > x - 0.3 && c.minX < x + 0.3 && c.maxZ > z - 0.3 && c.minZ < z + 0.3) {
        if (c.maxY <= y + 0.05 && c.maxY >= y - 0.65) return true;
      }
    }
  }
  return false;
}

export function buildNav(list: Collider[], grid: Grid): NavGraph {
  // bounds from real map boxes (skip the giant ground slab), +margin for the lawn
  let mnx = 1e9, mnz = 1e9, mxx = -1e9, mxz = -1e9;
  for (const c of list) {
    if (c.kind === 'box' && c.maxX - c.minX > 40) continue; // Col_Ground
    if (c.minX < mnx) mnx = c.minX; if (c.minZ < mnz) mnz = c.minZ;
    if (c.maxX > mxx) mxx = c.maxX; if (c.maxZ > mxz) mxz = c.maxZ;
  }
  mnx -= 8; mnz -= 8; mxx += 8; mxz += 8;
  const step = 0.5; // 1.4m doors need this: coarser grids can straddle a gap
  // with no cell center inside the passable band (alignment luck)
  const nx = Math.ceil((mxx - mnx) / step), nz = Math.ceil((mxz - mnz) / step);
  const layers = [0.05, 3.25];
  const nodes: NavNode[] = [];
  const cellNode = new Int32Array(nx * nz * layers.length).fill(-1);
  const at = (ix: number, iz: number, L: number) => cellNode[(ix * nz + iz) * layers.length + L];

  layers.forEach((ly, L) => {
    for (let ix = 0; ix < nx; ix++) {
      for (let iz = 0; iz < nz; iz++) {
        const x = mnx + (ix + 0.5) * step, z = mnz + (iz + 0.5) * step;
        if (!isFree(list, grid, x, ly, z, false)) continue;
        if (!supported(list, grid, x, ly, z)) continue;
        cellNode[(ix * nz + iz) * layers.length + L] = nodes.length;
        nodes.push({ x, y: ly, z });
      }
    }
  });

  const adj: number[][] = nodes.map(() => []);
  const link = (a: number, b: number) => {
    if (a < 0 || b < 0 || a === b) return;
    const dy = Math.abs(nodes[a].y - nodes[b].y);
    if (dy > 0.65) return;
    // Swept check: the 0.7m body travels the segment, not just endpoints.
    // A thin wall can sit exactly between two free cells. Test the center
    // line plus ±0.25m parallels in 0.25m steps — any clear line links.
    // (Bots steer, they don't rail-ride the center; ±0.25 covers all grid
    // alignments for gaps ≥1.0m.)
    const dx = nodes[b].x - nodes[a].x, dz = nodes[b].z - nodes[a].z;
    const len = Math.hypot(dx, dz) || 1;
    const steps = Math.max(1, Math.ceil(len / 0.25));
    const px = -dz / len, pz = dx / len;
    for (const off of [0, 0.25, -0.25]) {
      let ok = true;
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        if (!isFree(list, grid,
          nodes[a].x + dx * t + px * off, nodes[a].y, nodes[a].z + dz * t + pz * off,
          false)) { ok = false; break; }
      }
      if (ok) {
        if (!adj[a].includes(b)) adj[a].push(b);
        if (!adj[b].includes(a)) adj[b].push(a);
        return;
      }
    }
  };
  // 4-neighbour links within each layer
  for (let ix = 0; ix < nx; ix++) {
    for (let iz = 0; iz < nz; iz++) {
      for (let L = 0; L < layers.length; L++) {
        const a = at(ix, iz, L);
        if (a < 0) continue;
        if (ix + 1 < nx) link(a, at(ix + 1, iz, L));
        if (iz + 1 < nz) link(a, at(ix, iz + 1, L));
      }
    }
  }
  // ramp chains: walk the surface, link along + tie both ends to nearby nodes
  for (const c of list) {
    if (c.kind !== 'ramp') continue;
    const runLen = Math.abs(c.runHigh - c.runLow);
    const steps = Math.max(2, Math.ceil(runLen / 0.4));
    let prev = -1, first = -1;
    for (let s = 0; s <= steps; s++) {
      const along = c.runLow + (c.runHigh - c.runLow) * (s / steps);
      const cx = c.runAxis === 'x' ? along : (c.minX + c.maxX) / 2;
      const cz = c.runAxis === 'z' ? along : (c.minZ + c.maxZ) / 2;
      const t = (along - c.runLow) / (c.runHigh - c.runLow);
      const y = c.yLow + t * (c.yHigh - c.yLow) + 0.05;
      const idx = nodes.length;
      nodes.push({ x: cx, y, z: cz });
      adj.push([]);
      if (s === 0) first = idx;
      if (prev >= 0) { adj[prev].push(idx); adj[idx].push(prev); }
      prev = idx;
    }
    // tie ends to nearest layer nodes (the floors each end meets)
    for (const end of [first, prev]) {
      const e = nodes[end];
      let best = -1, bd = 1.6;
      for (let i = 0; i < nodes.length - (steps + 1); i++) {
        const d = Math.hypot(nodes[i].x - e.x, nodes[i].z - e.z);
        if (d < bd && Math.abs(nodes[i].y - e.y) < 0.7) { bd = d; best = i; }
      }
      if (best >= 0) { adj[end].push(best); adj[best].push(end); }
    }
  }
  void CFG;
  return { nodes, adj, minX: mnx, minZ: mnz, step, nx, nz, cellNode };
}

// nearest node to a point, preferring the caller's height (stairs have two layers)
export function nearestNode(g: NavGraph, x: number, y: number, z: number): number {
  let best = -1, bd = Infinity;
  for (let i = 0; i < g.nodes.length; i++) {
    const dx = g.nodes[i].x - x, dz = g.nodes[i].z - z;
    const dy = (g.nodes[i].y - y) * 2; // height counts double: don't snap across floors
    const d = dx * dx + dz * dz + dy * dy;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

// BFS path into `out` (node indices). Returns waypoint count. No alloc beyond out.
export function findPath(g: NavGraph, from: number, to: number, out: number[]): number {
  if (from < 0 || to < 0) return 0;
  if (from === to) { out[0] = to; return 1; }
  const prev = new Int32Array(g.nodes.length).fill(-1);
  const queue = [from];
  prev[from] = from;
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur === to) break;
    const nb = g.adj[cur];
    for (let i = 0; i < nb.length; i++) {
      if (prev[nb[i]] === -1) { prev[nb[i]] = cur; queue.push(nb[i]); }
    }
  }
  if (prev[to] === -1) return 0;
  // walk back (reverse into out via end-index)
  let n = 0, cur = to;
  while (cur !== from) { out[n++] = cur; cur = prev[cur]; }
  out[n++] = from;
  // reverse in place
  for (let i = 0; i < n / 2; i++) {
    const t = out[i]; out[i] = out[n - 1 - i]; out[n - 1 - i] = t;
  }
  return n;
}
