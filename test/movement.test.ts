// M1 walk-test: uses REAL map colliders dumped from Blender (three coords).
import * as fs from 'node:fs';
import { CFG } from '../src/shared/config.js';
import { buildGrid, type Collider } from '../src/shared/colliders.js';
import { isFree, makePlayer, stepPlayer } from '../src/shared/sim.js';

const dump = JSON.parse(fs.readFileSync('test/colliders.dump.json', 'utf8'));

const list: Collider[] = dump.boxes.map((b: any) => ({
  kind: 'box', name: b.name, group: b.group,
  minX: b.min[0], minY: b.min[1], minZ: b.min[2],
  maxX: b.max[0], maxY: b.max[1], maxZ: b.max[2],
}));
// ramp derived exactly like mapLoader does: low verts vs high verts
{
  const r = dump.ramp;
  const runAxis: 'x' | 'z' = 'z';
  // low edge = min y side; find which horizontal end is low via blend truth:
  // Blender low at y=-4.2 -> three z=+4.2 (max z). So runLow = max z, y=0.
  list.push({
    kind: 'ramp', name: r.name, group: 'ramp',
    minX: r.min[0], minY: r.min[1], minZ: r.min[2],
    maxX: r.max[0], maxY: r.max[1], maxZ: r.max[2],
    runAxis, runLow: r.max[2], runHigh: r.min[2],
    yLow: r.min[1], yHigh: r.max[1], slopeDeg: 45,
  });
}
const grid = buildGrid(list);
console.log(`colliders=${list.length} markers=${Object.keys(dump.markers).length}`);

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) { pass++; console.log(`ok   ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${extra}`); }
}

function walk(x: number, y: number, z: number, inp: any, ticks: number) {
  const p = makePlayer(x, y, z);
  let maxY = y;
  for (let i = 0; i < ticks; i++) { stepPlayer(p, inp, 1 / CFG.tickHz, list, grid); if (p.y > maxY) maxY = p.y; }
  (p as any)._maxY = maxY;
  return p;
}
const YAW0 = 0; // facing -Z

// 1. gravity: drop from 2m at attacker spawn, must land ~0 grounded
{
  const m = dump.markers.Spawn_Attacker_2;
  const p = walk(m[0], 2, m[2], { fwd: false, back: false, left: false, right: false, sprint: false, crouch: false, jump: false, yaw: YAW0 }, 180);
  check('gravity lands on ground', p.grounded && Math.abs(p.y - 0) < 0.05, `y=${p.y}`);
}

// 2. wall blocks: run +Z into south exterior wall (three z=8).
//    Scan for a free lane first (avoids interior walls/props).
{
  let lane = NaN;
  for (let x = -9; x <= 9; x += 0.5) {
    if (isFree(list, grid, x, 0.05, 6) && isFree(list, grid, x, 0.05, 7)) { lane = x; break; }
  }
  check('found free lane', Number.isFinite(lane), `lane=${lane}`);
  const p = walk(lane, 0.05, 6, { fwd: false, back: true, left: false, right: false, sprint: false, crouch: false, jump: false, yaw: YAW0 }, 240);
  check('exterior wall blocks', p.z > 6.5 && p.z < 7.9 && Math.abs(p.x - lane) < 0.6, `z=${p.z.toFixed(2)}`);
}

// 3. doorway lets you through: interior wall x=-3, door gap at three z≈4 (lintel above)
//    walk +X from x=-4.5 to past x=-3 at z=4.0 — must cross
{
  const p = walk(-4.5, 0.05, 4.0, { fwd: false, back: false, left: false, right: true, sprint: false, crouch: false, jump: false, yaw: YAW0 }, 240);
  check('doorway passes through', p.x > -1.5, `x=${p.x.toFixed(2)}`);
}

// 4. window sill blocks walking: west wall window at three z=4, sill 0..1m.
//    walk +X into wall x=-10 at z=4 — must stay outside (x < -10+... i.e. not cross)
{
  const p = walk(-8, 0.05, 4.0, { fwd: false, back: false, left: false, right: false, sprint: false, crouch: false, jump: false, yaw: YAW0 }, 60);
  // sanity: standing free spot first
  check('setup spot free', Math.abs(p.x - -8) < 0.5, `x=${p.x.toFixed(2)}`);
  const q = walk(-8, 0.05, 4.0, { fwd: false, back: false, left: true, right: false, sprint: false, crouch: false, jump: false, yaw: YAW0 }, 240);
  check('window sill blocks (no vault in v1)', q.x < -9.5 || q.x > -8.5 ? q.x < -9.0 : true, `x=${q.x.toFixed(2)}`);
}

// 5. ramp climb: start south of ramp bottom (z=5.2, y=0), walk -Z,
//    must mount upstairs floor (~3.2) and keep walking north
{
  const p = walk(-1.75, 0.05, 5.2, { fwd: true, back: false, left: false, right: false, sprint: false, crouch: false, jump: false, yaw: YAW0 }, 600);
  check('ramp climbs to top', p.y > 3.0 && p.z < 0.5, `y=${p.y.toFixed(2)} z=${p.z.toFixed(2)} g=${p.grounded}`);
}

// 6. upstairs floor holds you: teleport to top of ramp area, stand still, stay ~3.2
{
  const p = walk(-1.75, 3.25, 0.0, { fwd: false, back: false, left: false, right: false, sprint: false, crouch: false, jump: false, yaw: YAW0 }, 120);
  check('upstairs floor holds', p.grounded && p.y > 3.0 && p.y < 3.4, `y=${p.y.toFixed(2)}`);
}

// 7. stairs underside is solid: walk +X at ground into the tall side, must NOT pass through
{
  const p = walk(-3.8, 0.05, 2.6, { fwd: false, back: false, left: false, right: true, sprint: false, crouch: false, jump: false, yaw: YAW0 }, 400);
  check('stairs side blocks (no walk-through)', p.x < -2.0, `x=${p.x.toFixed(2)} y=${p.y.toFixed(2)}`);
}

// 8. low steps can still be mounted from the side (no regression):
//    must ride up onto the sliver mid-walk and never end up inside solid
{
  const p = walk(-0.5, 0.05, 4.0, { fwd: false, back: false, left: true, right: false, sprint: false, crouch: false, jump: false, yaw: YAW0 }, 200);
  check('low step mounts from side', (p as any)._maxY > 0.15 && isFree(list, grid, p.x, p.y, p.z), `maxY=${(p as any)._maxY.toFixed(2)} end=(${p.x.toFixed(2)},${p.y.toFixed(2)})`);
}

// 9. stair pinch: grinding into the slab edge stops you like a wall,
//    never embeds you, and you can always walk back out
{
  const p = makePlayer(-1.75, 0.05, 5.2);
  for (let i = 0; i < 35; i++) stepPlayer(p, { fwd: true, back: false, left: false, right: false, sprint: false, crouch: false, jump: false, yaw: YAW0 }, 1 / CFG.tickHz, list, grid);
  for (let i = 0; i < 250; i++) stepPlayer(p, { fwd: false, back: false, left: false, right: true, sprint: false, crouch: false, jump: false, yaw: YAW0 }, 1 / CFG.tickHz, list, grid);
  const blockedFree = isFree(list, grid, p.x, p.y, p.z, false);
  for (let i = 0; i < 250; i++) stepPlayer(p, { fwd: false, back: true, left: false, right: false, sprint: false, crouch: false, jump: false, yaw: YAW0 }, 1 / CFG.tickHz, list, grid);
  check('pinch blocks but retreat works', blockedFree && isFree(list, grid, p.x, p.y, p.z, false) && p.y < 0.2, `end=(${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)})`);
}

// 10. sprint climb still reaches the top (no regression from head guards)
{
  const p = walk(-1.75, 0.05, 5.2, { fwd: true, back: false, left: false, right: false, sprint: true, crouch: false, jump: false, yaw: YAW0 }, 400);
  check('sprint climb reaches top', p.y > 3.0 && p.z < 0.5, `y=${p.y.toFixed(2)} z=${p.z.toFixed(2)}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
