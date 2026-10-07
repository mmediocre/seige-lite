// End-to-end LAN interact: boots a real server, joins as DEFENDER with the real
// client stack (Netplay), walks to a slot with closed-loop steering, holds F.
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';

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
(globalThis as any).location = { host: 'localhost:3105' };

const PORT = 3105;
const server = spawn(process.execPath, ['server-dist/lan.mjs'], {
  cwd: process.cwd(), env: { ...process.env, PORT: String(PORT) },
});
await new Promise((r) => setTimeout(r, 1200));

const THREE = await import('three');
const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
const { splitScene } = await import('../src/client/mapLoader.js');
const { GunRig } = await import('../src/client/weapon.js');
const { Netplay } = await import('../src/client/netplay.js');
const { makePlayer, stepPlayer } = await import('../src/shared/sim.js');
const { buildGrid } = await import('../src/shared/colliders.js');

const bytes = fs.readFileSync('public/map_house.glb');
const buf: ArrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
const gltf: any = await new Promise((res, rej) => { new GLTFLoader().parse(buf, '', res, rej); });
const data = splitScene(gltf.scene);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, 1, 0.05, 200);
const el = fakeEl() as any;
const colliders = data.colliders;
const grid = buildGrid(colliders);
const gun = new GunRig(scene, camera, el);
const player = makePlayer(0, 0.1, -14);
const input = { yaw: 0, pitch: 0, fwd: false, back: false, left: false, right: false, sprint: false, crouch: false, jump: false };
const ui = {
  feed: fakeEl() as any, banner: fakeEl() as any, center: fakeEl() as any,
  board: fakeEl() as any, end: fakeEl() as any, lan: fakeEl() as any,
  interact: fakeEl() as any, hudExtra: (_s: string) => {},
};
const net = new Netplay(scene, camera, gun, player, input, colliders, grid,
  'Tester', 1, 0, ui, data.slotBoxes, data.destructibles);
await new Promise((r) => setTimeout(r, 600));

// second body on the OTHER team (keeps the round alive: needs both sides up)
const { WebSocket: WS } = await import('ws');
const B = new WS(`ws://localhost:${PORT}`);
await new Promise((r) => B.on('open', r as any));
{
  const nb = new TextEncoder().encode('Dummy');
  const b = new ArrayBuffer(4 + nb.length);
  const v = new DataView(b);
  v.setUint8(0, 1); v.setUint8(1, nb.length);
  new Uint8Array(b).set(nb, 2);
  v.setUint8(2 + nb.length, 0); v.setUint8(3 + nb.length, 0);
  B.send(b);
}
net.sendStart(); // host (first joiner)
console.log('joined, waiting for prep...');

// wait for match start (prep)
let waited = 0;
while (net.phase !== 0 || !net['started' as never]) {
  net.update(0.016);
  stepPlayer(player, input as any, 1 / 60, net.world.colliders, net.world.grid, 1);
  await new Promise((r) => setTimeout(r, 16));
  if (++waited > 600) { console.log('FAIL never started'); process.exit(1); }
}
console.log(`started, phase=${net.phase}`);

// closed-loop walk to L1_B slot center (3, 1.5), server moves the real sim
const TX = 2.4, TZ = 1.5;
let lastD = 1e9, stuck = 0;
for (let i = 0; i < 1200; i++) {
  const me = net.myEnt;
  const px = me ? me.x : player.x, pz = me ? me.z : player.z;
  const dx = TX - px, dz = TZ - pz;
  const d = Math.hypot(dx, dz);
  if (d < 1.2) break;
  input.yaw = Math.atan2(-dx, -dz);
  input.fwd = true;
  net.update(0.016);
  stepPlayer(player, input as any, 1 / 60, net.world.colliders, net.world.grid, 1);
  await new Promise((r) => setTimeout(r, 16));
  if (Math.abs(d - lastD) < 0.02) { if (++stuck > 120) break; } else stuck = 0;
  lastD = d;
}
input.fwd = false;
const me = net.myEnt;
console.log(`at server pos (${me?.x.toFixed(2)},${me?.z.toFixed(2)})`);

// hold F, watch server slot state come back through SNAP
net.setInteract(true);
let reinforced = false;
for (let i = 0; i < 200 && !reinforced; i++) {
  net.update(0.016);
  await new Promise((r) => setTimeout(r, 16));
  reinforced = net['slots'].some((s: any) => s.state === 'reinforced');
}
net.setInteract(false);
console.log(reinforced ? 'LAN REINFORCE WORKS' : 'LAN REINFORCE BROKEN');
if (!reinforced) { net.close(); server.kill(); process.exit(1); }

// part 2: wait for action, then shoot the wall we just built (L1_B)
console.log('waiting for action...');
let waited2 = 0;
while (net.phase !== 1 && waited2++ < 1000) {
  net.update(0.016);
  await new Promise((r) => setTimeout(r, 16));
}
// aim from the SERVER-known pos at L1_B center (server shoots from its own feet)
const se = net.myEnt!;
camera.position.set(se.x, se.y + 1.65, se.z);
camera.lookAt(3, 1.5, 1.5);
camera.updateMatrixWorld(true);
(gun as unknown as { trigger: boolean }).trigger = true;
const slotsOf = (net as unknown as { slots: any[] }).slots;
let shotHp = 50;
for (let i = 0; i < 120; i++) {
  gun.update(0.05);
  net.update(0.05);
  await new Promise((r) => setTimeout(r, 5));
  const s = slotsOf.find((q: any) => q.name === 'Reinforced_L1_B');
  if (s && s.hp < shotHp) shotHp = s.hp;
  if (shotHp <= 0) break;
}
(gun as unknown as { trigger: boolean }).trigger = false;
console.log(`wall hp after bullets: ${shotHp}`);
console.log(shotHp < 50 ? 'LAN WALL DAMAGE WORKS' : 'LAN WALL DAMAGE BROKEN');
net.close();
try { B.close(); } catch { /* gone */ }
server.kill();
process.exit(shotHp < 50 ? 0 : 1);
