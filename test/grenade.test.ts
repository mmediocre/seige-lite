import * as fs from 'node:fs';
import { buildGrid, type Collider } from '../src/shared/colliders.js';
import { hurt } from '../src/shared/combat.js';
import { blastDamage, makeNade, stepNade, throwNade, type BlastOut } from '../src/shared/grenade.js';
import { GADGETS } from '../src/shared/weapons.js';

const dump = JSON.parse(fs.readFileSync('test/colliders.dump.json', 'utf8'));
const list: Collider[] = dump.boxes.map((b: any) => ({ kind: 'box', name: b.name, group: b.group, minX: b.min[0], minY: b.min[1], minZ: b.min[2], maxX: b.max[0], maxY: b.max[1], maxZ: b.max[2] }));
const grid = buildGrid(list);
const DT = 1 / 60;

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) { pass++; console.log(`ok   ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${extra}`); }
}

// 1. dropped nade settles on the ground (not through it)
{
  const n = makeNade();
  throwNade(n, 0, 2, 14, 0, 0, 0);
  let boom = false;
  for (let i = 0; i < 100 && !boom; i++) boom = stepNade(n, DT, list, grid); // 1.6s < fuse
  check('nade rests on ground', !boom && Math.abs(n.y - 0.07) < 0.05, `y=${n.y.toFixed(2)}`);
}

// 2. fuse blows after ~3s even mid-air
{
  const n = makeNade();
  throwNade(n, 0, 30, 30, 0, 0, 0); // high above everything
  let ticks = 0, boom = false;
  while (!boom && ticks < 400) { boom = stepNade(n, DT, list, grid); ticks++; }
  check('fuse pops ~3s', boom && Math.abs(ticks * DT - GADGETS.frag.fuseS) < 0.1, `t=${(ticks * DT).toFixed(2)}`);
}

// 3. thrown at a wall it stays on our side
{
  const n = makeNade();
  throwNade(n, -3, 1.65, 10, 0, 0, -1); // at the south wall face z~8
  for (let i = 0; i < 120; i++) if (stepNade(n, DT, list, grid)) break;
  check('wall stops throw', n.z > 8.0, `z=${n.z.toFixed(2)}`);
}

// 4. blast: close hurts more than far
{
  const out: BlastOut[] = [{ i: 0, dmg: 0 }, { i: 0, dmg: 0 }];
  const nv = blastDamage(0, 1, 14,
    [{ x: 0, y: 1, z: 13 }, { x: 0, y: 1, z: 11 }], list, out);
  check('both in radius', nv === 2, `nv=${nv}`);
  check('close > far', out[0].dmg > out[1].dmg, `${out[0].dmg} vs ${out[1].dmg}`);
}

// 5. wall between boom and victim blocks it
{
  const out: BlastOut[] = [{ i: 0, dmg: 0 }];
  // boom south outside, victim just inside the wall (dist ~2m, would hurt)
  const nv = blastDamage(-3, 1, 10, [{ x: -3, y: 1, z: 7 }], list, out);
  check('wall blocks blast', nv === 0, `nv=${nv}`);
  const nv2 = blastDamage(-3, 1, 10, [{ x: -3, y: 1, z: 9 }], list, out);
  check('same side hurts', nv2 === 1 && out[0].dmg > 50, `dmg=${out[0].dmg}`);
}

// 6. hurt() kills at 0
{
  const [hp, alive] = hurt(30, 120);
  check('lethal damage kills', hp === 0 && !alive);
  const [hp2, alive2] = hurt(100, 30);
  check('chip damage survives', hp2 === 70 && alive2);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
