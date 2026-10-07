import * as fs from 'node:fs';
import { raycast, buildGrid, type Collider } from '../src/shared/colliders.js';
import { fireHitscan, makePelletPool, mulberry32 } from '../src/shared/combat.js';
import { WEAPONS } from '../src/shared/weapons.js';

const dump = JSON.parse(fs.readFileSync('test/colliders.dump.json', 'utf8'));
const list: Collider[] = dump.boxes.map((b: any) => ({ kind: 'box', name: b.name, group: b.group, minX: b.min[0], minY: b.min[1], minZ: b.min[2], maxX: b.max[0], maxY: b.max[1], maxZ: b.max[2] }));
{
  const r = dump.ramp;
  list.push({ kind: 'ramp', name: r.name, group: 'ramp', minX: r.min[0], minY: r.min[1], minZ: r.min[2], maxX: r.max[0], maxY: r.max[1], maxZ: r.max[2], runAxis: 'z', runLow: r.max[2], runHigh: r.min[2], yLow: r.min[1], yHigh: r.max[1], slopeDeg: 45 });
}
const grid = buildGrid(list);
void grid;
const world = (ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, m: number) =>
  raycast(list, ox, oy, oz, dx, dy, dz, m);

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) { pass++; console.log(`ok   ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${extra}`); }
}

// 1. pellet counts from the table
{
  const out = makePelletPool(8);
  check('AR fires 1 pellet', fireHitscan(0, 1.65, 6, 0, 0, 1, WEAPONS.ar, mulberry32(1), world, [], out) === 1);
  check('shotgun fires 8 pellets', fireHitscan(0, 1.65, 6, 0, 0, 1, WEAPONS.shotgun, mulberry32(1), world, [], out) === 8);
}

// 2. same seed, same shots
{
  const a = makePelletPool(8), b = makePelletPool(8);
  fireHitscan(0, 1.65, 6, 0, 0, 1, WEAPONS.shotgun, mulberry32(7), world, [], a);
  fireHitscan(0, 1.65, 6, 0, 0, 1, WEAPONS.shotgun, mulberry32(7), world, [], b);
  check('deterministic with seed', a.every((h, i) => h.px === b[i].px && h.dist === b[i].dist));
}

// 3. south wall at ~1.9m: full damage, world hit (spread off for exactness)
{
  const out = makePelletPool(1);
  const calm = { ...WEAPONS.ar, spreadHip: 0 };
  fireHitscan(-3, 1.65, 10, 0, 0, -1, calm, mulberry32(1), world, [], out);
  check('wall stops bullet ~1.9m', Math.abs(out[0].dist - 1.9) < 0.15, `dist=${out[0].dist.toFixed(2)}`);
  check('full damage up close', out[0].dmg === 26 && out[0].targetId === -1, `dmg=${out[0].dmg}`);
  check('face normal points back at shooter', out[0].nx === 0 && out[0].ny === 0 && out[0].nz === 1, `n=(${out[0].nx},${out[0].ny},${out[0].nz})`);
}

// 4. sky shot: nothing hit, no damage
{
  const out = makePelletPool(1);
  fireHitscan(-3, 1.65, 10, 0, 1, 0, { ...WEAPONS.ar, spreadHip: 0 }, mulberry32(1), world, [], out);
  check('sky shot misses, dmg 0', out[0].targetId === -1 && out[0].dmg === 0, `d=${out[0].dist}`);
}

// 5. target board in front of wall wins
{
  const out = makePelletPool(1);
  const calm = { ...WEAPONS.ar, spreadHip: 0 };
  const targets = [{ id: 0, minX: -3.2, minY: 1.2, minZ: 9.4, maxX: -2.8, maxY: 1.8, maxZ: 9.5 }];
  fireHitscan(-3, 1.65, 10, 0, 0, -1, calm, mulberry32(1), world, targets, out);
  check('target wins over wall', out[0].targetId === 0 && Math.abs(out[0].dist - 0.5) < 0.1, `id=${out[0].targetId} d=${out[0].dist.toFixed(2)}`);
}

// 6. spread stays inside the cone
{
  const out = makePelletPool(8);
  fireHitscan(0, 5, 20, 0, 0, -1, WEAPONS.shotgun, mulberry32(3), world, [], out);
  const maxAng = Math.max(...out.map((h) => Math.acos(-h.dz)));
  check('pellets inside cone', maxAng <= WEAPONS.shotgun.spreadHip + 0.002, `max=${maxAng.toFixed(4)}`);
}

// 7. falloff: mid-range damage between full and min (target board at ~29m in the open)
{
  const out = makePelletPool(1);
  const calm = { ...WEAPONS.ar, spreadHip: 0 };
  const targets = [{ id: 1, minX: 15, minY: 1.2, minZ: 13.8, maxX: 16, maxY: 1.8, maxZ: 14.2 }];
  fireHitscan(-14, 1.65, 14, 1, 0, 0, calm, mulberry32(1), world, targets, out);
  check('mid-range damage reduced', out[0].targetId === 1 && out[0].dmg < 26 && out[0].dmg > 15, `dmg=${out[0].dmg.toFixed(1)} d=${out[0].dist.toFixed(1)}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
