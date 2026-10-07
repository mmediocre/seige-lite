import * as fs from 'node:fs';
import { buildGrid, type Collider } from '../src/shared/colliders.js';
import { isFree } from '../src/shared/sim.js';
import { buildNav, findPath, nearestNode } from '../src/shared/nav.js';

const dump = JSON.parse(fs.readFileSync('test/colliders.dump.json', 'utf8'));
const list: Collider[] = dump.boxes.map((b: any) => ({ kind: 'box', name: b.name, group: b.group, minX: b.min[0], minY: b.min[1], minZ: b.min[2], maxX: b.max[0], maxY: b.max[1], maxZ: b.max[2] }));
{
  const r = dump.ramp;
  list.push({ kind: 'ramp', name: r.name, group: 'ramp', minX: r.min[0], minY: r.min[1], minZ: r.min[2], maxX: r.max[0], maxY: r.max[1], maxZ: r.max[2], runAxis: 'z', runLow: r.max[2], runHigh: r.min[2], yLow: r.min[1], yHigh: r.max[1], slopeDeg: 45 });
}
const grid = buildGrid(list);
const g = buildNav(list, grid);
console.log(`nodes=${g.nodes.length}`);

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) { pass++; console.log(`ok   ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${extra}`); }
}

check('graph built, sane size', g.nodes.length > 50 && g.nodes.length < 2200, `${g.nodes.length}`);
check('ramp chain exists', g.nodes.filter((n) => n.y > 0.5 && n.y < 3.0).length >= 4);

const out: number[] = new Array(2048).fill(0);
function pathBetween(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  return findPath(g, nearestNode(g, ax, ay, az), nearestNode(g, bx, by, bz), out);
}

// attacker spawn -> objective A (must enter the house somehow, not through walls)
{
  const m = dump.markers;
  const n = pathBetween(m.Spawn_Attacker_2[0], 0, m.Spawn_Attacker_2[2], m.Objective_A_Living[0], 0, m.Objective_A_Living[2]);
  check('spawn->site A path exists', n > 5, `n=${n}`);
  let ok = true;
  for (let i = 0; i < n; i++) {
    const w = g.nodes[out[i]];
    if (!isFree(list, grid, w.x, w.y, w.z, false)) { ok = false; break; }
    if (i > 0) {
      const p = g.nodes[out[i - 1]];
      if (Math.hypot(w.x - p.x, w.z - p.z) > 2.2 || Math.abs(w.y - p.y) > 0.75) { ok = false; break; }
    }
  }
  check('path waypoints walkable', ok);
  // crosses the south wall line (z=8) through the door gap or a window lane
  let crossX: number | null = null;
  for (let i = 1; i < n; i++) {
    const a = g.nodes[out[i - 1]], b = g.nodes[out[i]];
    if ((a.z - 8) * (b.z - 8) < 0) { crossX = (a.x + b.x) / 2; break; }
  }
  console.log(`  crosses z=8 at x=${crossX === null ? 'never' : crossX.toFixed(2)}`);
  check('path enters through opening', crossX !== null && (Math.abs(crossX) < 1.2 || Math.abs(Math.abs(crossX) - 6.5) < 1.2), `x=${crossX}`);
}

// defender spawn -> site B
{
  const m = dump.markers;
  const n = pathBetween(m.Spawn_Defender[0], 0, m.Spawn_Defender[2], m.Objective_B_Office[0], 0, m.Objective_B_Office[2]);
  check('defender->site B path exists', n >= 2, `n=${n}`);
}

// ground -> upstairs via ramp
{
  // bottom of stairs to a point upstairs north of the stairwell
  const n = pathBetween(-1.75, 0, 6, -1.75, 3.2, -2);
  check('stairs link floors', n > 4, `n=${n}`);
  let climbs = false;
  for (let i = 0; i < n; i++) {
    const w = g.nodes[out[i]];
    if (w.y > 1 && w.y < 3) climbs = true;
  }
  check('path climbs the ramp', climbs);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
