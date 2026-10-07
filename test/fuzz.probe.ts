import * as fs from 'node:fs';
import { CFG } from '../src/shared/config.js';
import { buildGrid, type Collider } from '../src/shared/colliders.js';
import { isFree, makePlayer, stepPlayer } from '../src/shared/sim.js';
import { mulberry32 } from '../src/shared/combat.js';

const dump = JSON.parse(fs.readFileSync('test/colliders.dump.json', 'utf8'));
const list: Collider[] = dump.boxes.map((b: any) => ({ kind: 'box', name: b.name, group: b.group, minX: b.min[0], minY: b.min[1], minZ: b.min[2], maxX: b.max[0], maxY: b.max[1], maxZ: b.max[2] }));
{
  const r = dump.ramp;
  list.push({ kind: 'ramp', name: r.name, group: 'ramp', minX: r.min[0], minY: r.min[1], minZ: r.min[2], maxX: r.max[0], maxY: r.max[1], maxZ: r.max[2], runAxis: 'z', runLow: r.max[2], runHigh: r.min[2], yLow: r.min[1], yHigh: r.max[1], slopeDeg: 45 });
}
const grid = buildGrid(list);

// spawn spots: stair approaches, doorways, under-stair edges, upstairs lips
const spots: [number, number, number][] = [
  [-1.75, 0.05, 5.2], [-1.75, 0.05, 4.5], [-0.5, 0.05, 4.0], [-3.0, 0.05, 4.0],
  [-1.75, 1.5, 2.6], [-2.3, 1.7, 2.5], [-1.2, 2.5, 1.5], [-1.75, 3.25, 0.5],
  [-4.5, 0.05, 4.0], [-0.5, 0.05, 2.6], [-1.75, 0.05, 0.5], [-2.5, 0.05, 1.0],
];
let bad = 0;
let legal = 0;
for (let seed = 1; seed <= 6; seed++) {
  const rng = mulberry32(seed);
  for (const [sx, sy, sz] of spots) {
    if (!isFree(list, grid, sx, sy, sz, false)) continue; // only legal starts count
    legal++;
    const p = makePlayer(sx, sy, sz);
    let yaw = rng() * Math.PI * 2;
    for (let t = 0; t < 600; t++) {
      if (rng() < 0.05) yaw += (rng() - 0.5) * 3;
      const inp = {
        fwd: rng() < 0.7, back: false, left: rng() < 0.2, right: rng() < 0.2,
        sprint: rng() < 0.4, crouch: rng() < 0.15, jump: rng() < 0.08, yaw,
      };
      stepPlayer(p, inp, 1 / CFG.tickHz, list, grid);
      if (!Number.isFinite(p.x + p.y + p.z)) { console.log(`seed ${seed} NaN at t${t}`); bad++; break; }
      if (p.y < -0.5) { console.log(`seed ${seed} UNDER MAP (${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}) at t${t} from (${sx},${sy},${sz})`); bad++; break; }
    }
    if (!isFree(list, grid, p.x, p.y, p.z, false) && p.y > -0.5) {
      // possibly beached: try walking out in all 4 directions (with a hop);
      // fail only if it cannot reach free space or move
      const dirs = [
        { fwd: true, back: false, left: false, right: false },
        { fwd: false, back: true, left: false, right: false },
        { fwd: false, back: false, left: true, right: false },
        { fwd: false, back: false, left: false, right: true },
      ];
      let escaped = false;
      for (const d of dirs) {
        const q = makePlayer(p.x, p.y, p.z);
        for (let t = 0; t < 90; t++) {
          stepPlayer(q, { ...d, sprint: false, crouch: false, jump: t === 30, yaw: 0 }, 1 / CFG.tickHz, list, grid);
        }
        if (isFree(list, grid, q.x, q.y, q.z, false) || Math.hypot(q.x - p.x, q.z - p.z) > 1.5) { escaped = true; break; }
      }
      if (!escaped) {
        console.log(`seed ${seed} STUCK at (${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}) from (${sx},${sy},${sz})`);
        bad++;
      }
    }
  }
}
console.log(`legal starts: ${legal}`);
console.log(bad === 0 ? 'NO UNDER-MAP FOUND' : `${bad} UNDER-MAP EVENTS`);
process.exit(bad ? 1 : 0);
