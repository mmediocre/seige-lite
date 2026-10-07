// Headless solo-match driver: stubs just enough DOM for match.ts + weapon.ts,
// loads the REAL map, plays defender prep, holds F at a real slot.
import * as fs from 'node:fs';

// ---- minimal DOM stubs (no rendering happens headless) ----
function fake2d() {
  return {
    createRadialGradient: () => ({ addColorStop() {} }),
    fillRect() {}, clearRect() {}, fillText() {},
    font: '', textAlign: '', fillStyle: '',
  };
}
function fakeEl() {
  return {
    style: {}, textContent: '', innerHTML: '',
    onclick: null as null | (() => void),
    querySelector: () => ({ textContent: '' }),
    querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {},
    requestPointerLock() {},
  };
}
(globalThis as any).document = {
  getElementById: (_id: string) => fakeEl(),
  createElement: (tag: string) => tag === 'canvas'
    ? { width: 0, height: 0, getContext: () => fake2d() }
    : fakeEl(),
  addEventListener() {},
  exitPointerLock() {},
  pointerLockElement: null,
};
(globalThis as any).addEventListener = () => {};
(globalThis as any).location = { host: 'localhost:3000' };

const THREE = await import('three');
const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
const { splitScene } = await import('../src/client/mapLoader.js');
const { GunRig } = await import('../src/client/weapon.js');
const { SoloMatch } = await import('../src/client/match.js');
const { buildGrid } = await import('../src/shared/colliders.js');

const bytes = fs.readFileSync('public/map_house.glb');
const buf: ArrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
const gltf: any = await new Promise((res, rej) => { new GLTFLoader().parse(buf, '', res, rej); });
const data = splitScene(gltf.scene);
console.log(`slots: ${data.slotBoxes.map((s) => s.name).join(', ')}`);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, 1, 0.05, 200);
const el = fakeEl() as any;
const colliders = data.colliders;
const grid = buildGrid(colliders);
const gun = new GunRig(scene, camera, el);
gun.buildTargets(colliders);
const grid2 = buildGrid(colliders);
gun.setWorld(colliders, grid2);

const match = new SoloMatch(scene, gun, colliders, grid2, data.markers, 'def', 'recruit', data.slotBoxes, data.destructibles);
console.log(`phase=${match.st.phase} playerSide=${match.st.playerSide}`);
console.log(`slot states: ${match['slots'].map((s: any) => `${s.name}=${s.state}`).join(', ')}`);

// walk player entity to a reachable OPEN ground slot, hold F
const slots = match['slots'] as any[];
const open = slots.find((s) => s.state === 'open' && s.minY < 1.5) ?? slots.find((s) => s.state === 'open');
console.log(`trying slot ${open.name} center ${(open.minX + open.maxX) / 2}, ${(open.minZ + open.maxZ) / 2}`);
console.log(`box x[${open.minX},${open.maxX}] y[${open.minY},${open.maxY}] z[${open.minZ},${open.maxZ}]`);
const e = match.entities[0];
e.x = (open.minX + open.maxX) / 2;
e.z = (open.minZ + open.maxZ) / 2;
e.y = 0.05;
match.setPlayerInteract(true);
match.update(0.05); // drains roundStart (resets positions, like the real game)
// NOW walk to the slot (as the player would after spawning)
e.x = (open.minX + open.maxX) / 2;
e.z = (open.minZ + open.maxZ) / 2;
e.y = 0.05;
console.log(`at slot: pos=${e.x},${e.y},${e.z} held=${match['interactHeld']}`);
for (let i = 0; i < 10; i++) match.update(0.05);
console.log(`after F: ${open.name}=${open.state}`);
console.log(open.state === 'reinforced' ? 'REINFORCE WORKS' : 'REINFORCE BROKEN');
process.exit(open.state === 'reinforced' ? 0 : 1);
