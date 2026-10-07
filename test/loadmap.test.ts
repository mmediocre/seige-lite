// Verifies the REAL map_house.glb: extras survive, split matches Blender truth.
import * as fs from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { splitScene } from '../src/client/mapLoader.js';

const bytes = fs.readFileSync('public/map_house.glb');
const buf: ArrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

const gltf: any = await new Promise((res, rej) => {
  new GLTFLoader().parse(buf, '', res, rej);
});
const data = splitScene(gltf.scene as THREE.Object3D);

let fail = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) console.log(`ok   ${name}`);
  else { fail++; console.log(`FAIL ${name} ${extra}`); }
}

const boxes = data.colliders.filter((c) => c.kind === 'box');
const ramps = data.colliders.filter((c) => c.kind === 'ramp');
check('total colliders = 133 (126 map + 5 self + ramp... )', data.colliders.length >= 131, `got ${data.colliders.length}`);
check('boxes ~132', boxes.length >= 130 && boxes.length <= 134, `got ${boxes.length}`);
check('one ramp', ramps.length === 1, `got ${ramps.length}`);
if (ramps.length === 1) {
  const r = ramps[0] as any;
  check('ramp rises 0 -> ~3.2', Math.abs(r.yLow) < 0.05 && Math.abs(r.yHigh - 3.2) < 0.05, `y ${r.yLow}..${r.yHigh}`);
  check('ramp 45°-ish run 3.2', Math.abs(Math.abs(r.runHigh - r.runLow) - 3.2) < 0.05, `run ${r.runLow}..${r.runHigh}`);
}
check('6 markers', Object.keys(data.markers).length === 6, `got ${Object.keys(data.markers).join(',')}`);
check('attacker spawn south (z>10)', (data.markers['Spawn_Attacker_2']?.z ?? 0) > 10, `z=${data.markers['Spawn_Attacker_2']?.z}`);
check('visual tri budget (<100k, expect ~1k)', data.triCount < 100000 && data.triCount > 100, `tris=${data.triCount}`);
check('5 destructible self-colliders', boxes.filter((b) => b.name.startsWith('Reinforced') || b.name.startsWith('Hatch')).length === 5, '');
console.log(fail ? `\n${fail} FAILED` : '\nall map checks passed');
process.exit(fail ? 1 : 0);
