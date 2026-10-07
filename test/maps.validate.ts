// New-map acceptance: every map in public/map_*.glb must be playable:
// convention boxes, working ramp, nav path spawn->site, walkable by sim.
import * as fs from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { splitScene } from '../src/client/mapLoader.js';
import { buildGrid, type Collider } from '../src/shared/colliders.js';
import { isFree, makePlayer, stepPlayer } from '../src/shared/sim.js';
import { buildNav, findPath, nearestNode } from '../src/shared/nav.js';
import { CFG } from '../src/shared/config.js';

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) { pass++; console.log(`ok   ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${extra}`); }
}

for (const f of ['map_house.glb', 'map_house_large.glb', 'map_warehouse.glb']) {
  console.log(`--- ${f} ---`);
  const bytes = fs.readFileSync(`public/${f}`);
  const buf: ArrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const gltf: any = await new Promise((res, rej) => { new GLTFLoader().parse(buf, '', res, rej); });
  const data = splitScene(gltf.scene);
  const list: Collider[] = data.colliders;
  const grid = buildGrid(list);

  check(`${f} 5 slots`, data.slotBoxes.length === 5, `${data.slotBoxes.length}`);
  check(`${f} attacker spawns`, !!data.markers['Spawn_Attacker_1'] && !!data.markers['Spawn_Attacker_2'] && !!data.markers['Spawn_Attacker_3']);
  check(`${f} defender + both sites`, !!data.markers['Spawn_Defender'] && !!data.markers['Objective_A_Living'] && !!data.markers['Objective_B_Office']);
  check(`${f} tri budget`, data.triCount < 100000, `${data.triCount}`);

  const nav = buildNav(list, grid);
  const out: number[] = new Array(2048).fill(0);
  const sp = data.markers['Spawn_Attacker_2'];
  const siteA = data.markers['Objective_A_Living'];
  const siteB = data.markers['Objective_B_Office'];

  // every Objective_* site: reachable on foot from attacker spawn + walked
  const siteNames = Object.keys(data.markers).filter((k) => k.startsWith('Objective_')).sort();
  check(`${f} has sites`, siteNames.length >= 2, siteNames.join(','));
  for (const sn of siteNames) {
    const site = data.markers[sn];
    const n = findPath(nav, nearestNode(nav, sp.x, 0, sp.z), nearestNode(nav, site.x, site.y, site.z), out);
    check(`${f} path spawn->${sn}`, n > 3, `n=${n}`);
    const p = makePlayer(sp.x, sp.y + 0.1, sp.z);
    let arrived = false, wp = 0;
    for (let t = 0; t < 4000 && !arrived; t++) {
      const w = nav.nodes[out[Math.min(wp, n - 1)]];
      const dx = w.x - p.x, dz = w.z - p.z;
      if (Math.hypot(dx, dz) < 0.6) {
        wp++;
        if (wp >= n) { arrived = true; break; }
        continue;
      }
      const yaw = Math.atan2(-dx, -dz);
      stepPlayer(p, { fwd: true, back: false, left: false, right: false, sprint: false, crouch: false, jump: false, yaw }, 1 / CFG.tickHz, list, grid);
      if (p.y < -1) break;
    }
    const left = Math.hypot(p.x - site.x, p.z - site.z);
    check(`${f} bot walks to ${sn}`, arrived || left < 2.5, `left=${left.toFixed(1)}m`);
  }

  // defender spawn offsets around EACH site must be standing room
  for (const sn of siteNames) {
    const site = data.markers[sn];
    const offs = [[1.5, 1.5], [-1.5, 1.5], [0, -2.5]];
    const free = offs.filter(([ox, oz]) => isFree(list, grid, site.x + ox, site.y + 0.1, site.z + oz, false));
    check(`${f} ${sn} spawn room ${free.length}/3`, free.length >= 2, `site=(${site.x.toFixed(1)},${site.y.toFixed(1)},${site.z.toFixed(1)})`);
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
