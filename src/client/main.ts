// M1-M4: render loop. Walk test (aim + boards) or solo match (bots + rounds).
import * as THREE from 'three';
import { CFG } from '../shared/config.js';
import { buildGrid, type Collider } from '../shared/colliders.js';
import { makePlayer, stepPlayer, type Player } from '../shared/sim.js';
import { bindInput, clearKeys, consumeLook, makeInput } from './input.js';
import { findMarker, hasTag, loadMap, siteLetter } from './mapLoader.js';import { GunRig } from './weapon.js';
import { SoloMatch } from './match.js';
import { Netplay } from './netplay.js';
import { paintLoadout, makeSiteBeacon } from './labels.js';
import { getBind, getInvertY, getSens, labelFor, resetBinds, setBind, setInvertY, setSens, ACTIONS } from './bindings.js';
import { MAP_FILES, MAP_NAMES } from '../shared/maps.js';
import { buildNav, type NavGraph } from '../shared/nav.js';
const navCache = new Map<number, NavGraph>(); // built once per map load, reused every match
import type { SlotBox } from './mapLoader.js';
import type { Side } from '../shared/rounds.js';
import { hurt } from '../shared/combat.js';
import { blastDamage, type BlastOut } from '../shared/grenade.js';

const hud = document.getElementById('hud')!;
const menu = document.getElementById('menu')!;
const app = document.getElementById('app')!;

const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'low-power' });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1)); // hard cap for old GPUs
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = false;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(CFG.bgColor);
scene.fog = new THREE.Fog(CFG.fogColor, 10, CFG.viewDistance);

const camera = new THREE.PerspectiveCamera(CFG.fov, innerWidth / innerHeight, 0.05, 200);
scene.add(camera); // holds the gun viewmodel

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

const input = makeInput();
bindInput(renderer.domElement, input);
const gun = new GunRig(scene, camera, renderer.domElement);

let colliders: Collider[] = [];
let grid = buildGrid([]);
let markers: Record<string, THREE.Vector3> = {};
let slotBoxes: SlotBox[] = [];
let slotMeshes: THREE.Object3D[] = [];
let player: Player = makePlayer(0, 0.1, -14);
let hp: number = CFG.playerHp;
let dead = false;
let lastSpawn = 'Spawn_Attacker_2';
const deadBox = document.getElementById('dead')!;
let yaw = 0, pitch = 0;
let debugGroup: THREE.Group | null = null;
let debugOn = false;
let mapTris = 0;
let mapReady = false;

const MAPS = MAP_FILES.map((file, i) => ({ file, name: MAP_NAMES[i] ?? file }));
let mapIdx = 0;
let mapVisuals: THREE.Object3D | null = null;

async function loadMapFile(idx: number): Promise<void> {
  mapIdx = idx;
  mapReady = false;
  hud.textContent = 'loading map…';
  try {
    const base = import.meta.env.BASE_URL || './';
    if (mapVisuals) {
      scene.remove(mapVisuals);
      gun.clearTargets(); // boards + post colliders belong to the old map
    }
    const data = await loadMap(base + MAPS[idx].file);
    mapVisuals = data.visuals;
    scene.add(data.visuals);
    colliders = data.colliders;
    // practice boards behind attacker spawn 2 (every map has that marker)
    const sp2 = findMarker(data.markers, 'Spawn_Attacker_2');
    if (sp2) gun.buildTargets(colliders, sp2.x, sp2.z + 4);
    grid = buildGrid(colliders);
    gun.setWorld(colliders, grid);
    markers = data.markers;
    slotBoxes = data.slotBoxes;
    slotMeshes = data.destructibles;
    refreshWalkBeacons();
    if (!navCache.has(idx)) {
      hud.textContent = `building bot paths…`;
      await new Promise((r) => setTimeout(r, 10)); // let the hud paint first
      navCache.set(idx, buildNav(colliders, grid));
    }
    void gun.loadModels(`${base}guns`); // real viewmodels; code boxes until loaded
    mapTris = data.triCount;
    mapReady = true;
    hud.textContent = `map ok: ${MAPS[idx].name} (${colliders.length} colliders)`;
    paintMapBtns();
  } catch (e) {
    hud.textContent = 'MAP LOAD FAILED: ' + String(e);
    throw e;
  }
}
void loadMapFile(0);

function paintMapBtns(): void {
  document.querySelectorAll<HTMLButtonElement>('#maprow button').forEach((b) => {
    b.style.border = Number(b.dataset.map) === mapIdx ? '2px solid #ffd34d' : '';
  });
}
document.querySelectorAll<HTMLButtonElement>('#maprow button').forEach((b) => {
  b.onclick = () => { void loadMapFile(Number(b.dataset.map)); };
});

function spawnAt(name: string): void {
  const m = findMarker(markers, name);
  if (m) {
    // markers are floor points; feet = marker + small lift
    player = makePlayer(m.x, m.y + 0.1, m.z);
    lastSpawn = name;
  }
  hp = CFG.playerHp;
  dead = false;
  deadBox.style.display = 'none';
  gun.refillNades();
  menu.style.display = 'none';
  refreshWalkPicker();
  refreshWalkBeacons();
  renderer.domElement.requestPointerLock?.();
}
deadBox.onclick = () => spawnAt(lastSpawn);

document.getElementById('sp0')!.onclick = () => spawnAt('Spawn_Attacker_2');
document.getElementById('sp1')!.onclick = () => spawnAt('Spawn_Defender');
document.getElementById('sp2')!.onclick = () => spawnAt('Objective_A_Living');

// --- solo match (M4) ---
let match: SoloMatch | null = null;
let difficulty: 'recruit' | 'regular' = 'recruit';
const diffBtn = document.getElementById('diff')!;
function paintDiff(): void {
  diffBtn.textContent = `Bots: ${difficulty === 'recruit' ? 'Recruit (easy)' : 'Regular'}`;
}
diffBtn.onclick = () => {
  difficulty = difficulty === 'recruit' ? 'regular' : 'recruit';
  paintDiff();
};
paintDiff();
document.getElementById('mAtk')!.onclick = () => startMatch('atk');
document.getElementById('mDef')!.onclick = () => startMatch('def');
document.getElementById('matchend')!.onclick = () => exitMatch();

function startMatch(side: Side): void {
  if (!mapReady) return;
  exitMatch(); // clean slate
  if (!navCache.has(mapIdx)) navCache.set(mapIdx, buildNav(colliders, grid));
  match = new SoloMatch(scene, gun, colliders, grid, markers, side, difficulty, slotBoxes, slotMeshes, navCache.get(mapIdx)!);
  match.setHudVisible(true);
  gun.setWorld(match.world.colliders, match.world.grid);
  const sp = match.playerSpawn;
  player = makePlayer(sp.x, sp.y, sp.z);
  yaw = input.yaw = side === 'atk' ? 0 : Math.PI; // attackers face the house
  input.pitch = 0;
  hp = CFG.playerHp; dead = false;
  deadBox.style.display = 'none';
  menu.style.display = 'none';
  document.getElementById('matchend')!.onclick = () => exitMatch();
  refreshWalkBeacons();
  renderer.domElement.requestPointerLock?.();
}

function exitMatch(): void {
  if (match) { match.setHudVisible(false); match.dispose(); match = null; }
  closeChat();
  refreshWalkBeacons();
  gun.acceptTrigger = true;
  gun.setWorld(colliders, grid);
  for (const m of slotMeshes) m.visible = true; // walk mode: walls closed
  document.getElementById('interact')!.textContent = '';
  const me = document.getElementById('matchend')!;
  me.style.display = 'none';
  menu.style.display = 'flex';
}

// --- LAN multiplayer (M5) ---
let lan: Netplay | null = null;
let lanSide: 0 | 1 = 0;
let lanGun = 0;
let lanPing = '';
const lanDiv = document.getElementById('lan')!;
const GUNNAMES = ['Rifle', 'SMG', 'Shotgun', 'Pistol', 'MachPistol'];
document.getElementById('lanside')!.onclick = (e) => {
  lanSide = lanSide === 0 ? 1 : 0;
  (e.target as HTMLElement).textContent = `Team: ${lanSide === 0 ? 'ATTACK' : 'DEFEND'}`;
};
document.getElementById('langun')!.onclick = (e) => {
  lanGun = (lanGun + 1) % 3; // primaries at join; 4/5 switchable in game
  (e.target as HTMLElement).textContent = `Gun: ${GUNNAMES[lanGun]}`;
};
document.getElementById('lanjoin')!.onclick = () => startLan();
document.getElementById('lanback')!.onclick = () => exitLan();
// pre-fill a name that's already unique-ish (server still de-dupes)
(document.getElementById('lanname') as HTMLInputElement).value = `Player${1 + Math.floor(Math.random() * 99)}`;
// controls panel: rebind keys, mouse sens, invert
{
  const panel = document.getElementById('controls')!;
  const rows = document.getElementById('bindrows')!;
  const sens = document.getElementById('sens') as HTMLInputElement;
  const sensVal = document.getElementById('sensval')!;
  const invY = document.getElementById('inverty') as HTMLInputElement;
  document.getElementById('ctlshow')!.onclick = () => {
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
  };
  const paint = () => {
    rows.innerHTML = '';
    for (const a of ACTIONS) {
      const row = document.createElement('div');
      const lab = document.createElement('span');
      lab.textContent = `${a.label}: `;
      const btn = document.createElement('button');
      btn.textContent = labelFor(getBind(a.id));
      btn.onclick = () => {
        btn.textContent = 'press…';
        const once = (e: KeyboardEvent) => {
          e.preventDefault();
          removeEventListener('keydown', once);
          if (e.code !== 'Escape') setBind(a.id, e.code);
          paint();
        };
        addEventListener('keydown', once);
      };
      row.append(lab, btn);
      rows.append(row);
    }
    sens.value = String(getSens());
    sensVal.textContent = `${Math.round(getSens() * 100)}%`;
    invY.checked = getInvertY();
  };
  sens.oninput = () => { setSens(Number(sens.value)); paint(); };
  invY.onchange = () => setInvertY(invY.checked);
  document.getElementById('bindreset')!.onclick = () => { resetBinds(); paint(); };
  paint();
}
// loadout picker (shown between rounds by match/netplay, always in walk mode)
function refreshWalkPicker(): void {
  if (!match && !lan) paintLoadout(true, gun.loadout.primary, gun.loadout.secondary);
}
document.querySelectorAll<HTMLButtonElement>('#loadout button[data-pri]').forEach((b) => {
  b.onclick = () => { gun.setPri(Number(b.dataset.pri)); refreshWalkPicker(); };
});
document.querySelectorAll<HTMLButtonElement>('#loadout button[data-sec]').forEach((b) => {
  b.onclick = () => { gun.setSec(Number(b.dataset.sec)); refreshWalkPicker(); };
});

function startLan(): void {
  if (!mapReady || lan) return;
  exitMatch();
  const name = ((document.getElementById('lanname') as HTMLInputElement).value || 'Player').slice(0, 12);
  menu.style.display = 'none';
  lanDiv.style.display = 'flex';
  (document.getElementById('lanlist')!).innerHTML = '<div>connecting…</div>';
  lan = new Netplay(scene, camera, gun, player, input, colliders, grid, name, lanSide, lanGun, {
    feed: document.getElementById('feed')!,
    banner: document.getElementById('banner')!,
    center: document.getElementById('center')!,
    board: document.getElementById('board')!,
    end: document.getElementById('matchend')!,
    lan: lanDiv,
    interact: document.getElementById('interact')!,
    hudExtra: (s) => { lanPing = s; },
  }, slotBoxes, slotMeshes);
  lan.onMapChange = async (idx) => {
    await loadMapFile(idx);
    lan?.reloadMap(colliders, grid, slotBoxes, slotMeshes);
    if (lan) pushSites(lan);
  };
  lan.curMap = mapIdx; // force host-map sync on first lobby even if unchanged
  document.getElementById('lanstart')!.onclick = () => lan?.sendStart();
  document.getElementById('matchend')!.onclick = () => {
    if (lan && lan.stayInLobby()) lan.backToLobby();
    else exitLan();
  };
  document.getElementById('banner')!.style.display = 'block';
  document.getElementById('feed')!.style.display = 'block';
  deadBox.style.display = 'none';
  hp = CFG.playerHp; dead = false;
  refreshWalkBeacons();
  if (lan) pushSites(lan);
  renderer.domElement.requestPointerLock?.();
}

// every Objective_* marker, sorted (attack one per round, LAN + solo agree)
function pushSites(target: { setSites: (names: string[], coords: number[]) => void }): void {
  const names = Object.keys(markers).filter((k) => hasTag(k, 'Objective_')).sort();
  const coords: number[] = [];
  for (const n of names) {
    const m = markers[n];
    coords.push(m.x, m.y, m.z);
  }
  target.setSites(names, coords);
}

function exitLan(): void {
  if (lan) { lan.close(); lan = null; }
  closeChat();
  refreshWalkBeacons();
  gun.acceptTrigger = true;
  gun.setWorld(colliders, grid);
  for (const m of slotMeshes) m.visible = true; // walk mode: walls closed
  document.getElementById('interact')!.textContent = '';
  for (const id of ['banner', 'feed', 'center', 'board', 'matchend', 'loadout']) {
    document.getElementById(id)!.style.display = 'none';
  }
  document.getElementById('chat')!.innerHTML = ''; // fresh log next session
  lanDiv.style.display = 'none';
  lanPing = '';
  menu.style.display = 'flex';
}

addEventListener('keydown', (e) => {
  if (e.code === getBind('debug')) { e.preventDefault(); toggleDebug(); }
  // F2-F4 teleport for walk-test (1/2 hold your gun pair)
  if (e.code === 'F2') spawnAt('Spawn_Attacker_2');
  if (e.code === 'F3') spawnAt('Spawn_Defender');
  if (e.code === 'F4') spawnAt('Objective_A_Living');
  if (e.code === getBind('interact') && !chatOpen) interactHeld = true;
  if (e.code === 'KeyX' && !chatOpen && !match && !lan) {
    walkSiteIdx++;
    refreshWalkBeacons();
  }
  if (e.code === getBind('hideUI') && !e.repeat) toggleHideUI();
  if (e.code === getBind('score') && (match || lan)) {
    e.preventDefault();
    if (match) match.setScoreboard(true);
    else lan!.setScoreboard(true);
  }
  if (e.code === getBind('quit') && !chatOpen && (match || lan)) {
    if (match) exitMatch();
    else exitLan();
  }
  if (e.code === getBind('chat') && !e.repeat && lan && !chatOpen) openChat();
  else if (e.code === 'Enter' && chatOpen) sendChat();
  else if (e.code === 'Escape' && chatOpen) closeChat();
});
addEventListener('keyup', (e) => {
  if (e.code === getBind('score') && match) match.setScoreboard(false);
  if (e.code === getBind('score') && lan) lan.setScoreboard(false);
  if (e.code === getBind('interact')) interactHeld = false;
});
let interactHeld = false;
let chatOpen = false;
const chatRow = document.getElementById('chatrow')!;
const chatInput = document.getElementById('chatinput') as HTMLInputElement;

function openChat(): void {
  chatOpen = true;
  input.chatOpen = true;
  gun.uiBlocked = true;
  interactHeld = false;
  clearKeys(input); // stop walking while typing
  chatRow.style.display = 'block';
  chatInput.value = '';
  setTimeout(() => chatInput.focus(), 0);
}
function closeChat(): void {
  chatOpen = false;
  input.chatOpen = false;
  gun.uiBlocked = false;
  chatRow.style.display = 'none';
  chatInput.blur();
}
function sendChat(): void {
  const text = chatInput.value.trim();
  if (text && lan) lan.sendChat(text);
  closeChat();
}
// click while dead in a match: cycle spectate target
document.addEventListener('mousedown', (e) => {
  if (match && !match.playerAlive() && e.button === 0) match.nextSpectate();
  if (lan && !lan.amAlive() && e.button === 0) lan.nextSpectate();
});

// hide every HUD element (screenshots / clean view). CSS does the work.
function toggleHideUI(): void {
  document.body.classList.toggle('hideui');
}

function toggleDebug(): void {  debugOn = !debugOn;
  if (debugGroup) { scene.remove(debugGroup); debugGroup = null; }
  if (!debugOn) return;
  debugGroup = new THREE.Group();
  const colorOf = (c: Collider) =>
    c.kind === 'ramp' ? 0xffff00 : c.group === 'floor' ? 0x00ff00 : c.group === 'prop' ? 0x4488ff : 0xff4444;
  for (const c of colliders) {
    const sx = c.maxX - c.minX, sy = c.maxY - c.minY, sz = c.maxZ - c.minZ;
    const g = new THREE.BoxGeometry(sx || 0.01, sy || 0.01, sz || 0.01);
    const m = new THREE.LineBasicMaterial({ color: colorOf(c) });
    const box = new THREE.LineSegments(new THREE.EdgesGeometry(g), m);
    box.position.set((c.minX + c.maxX) / 2, (c.minY + c.maxY) / 2, (c.minZ + c.maxZ) / 2);
    debugGroup.add(box);
  }
  scene.add(debugGroup);
}

// walk-mode site beacon (one at a time, X flips through; match/lan own theirs)
const walkBeacons: { group: THREE.Group; set: (x: number, y: number, z: number, color: number) => void; tick: (dt: number) => void }[] = [];
let walkBeaconKey = '';
let walkSiteIdx = 0;
function refreshWalkBeacons(): void {
  const names = Object.keys(markers).filter((k) => hasTag(k, 'Objective_')).sort();
  const key = names.join(',');
  if (key !== walkBeaconKey) {
    walkBeaconKey = key;
    walkSiteIdx = 0;
    for (const b of walkBeacons) scene.remove(b.group);
    walkBeacons.length = 0;
    for (const n of names) {
      const b = makeSiteBeacon(siteLetter(n));
      scene.add(b.group);
      walkBeacons.push(b);
    }
  }
  if (walkBeacons.length > 0) walkSiteIdx %= walkBeacons.length;
  const show = !match && !lan && walkBeacons.length > 0;
  walkBeacons.forEach((b, i) => {
    const on = show && i === walkSiteIdx;
    b.group.visible = on;
    if (on) {
      const m = markers[names[i]];
      b.set(m.x, m.y, m.z, 0xffd34d);
    }
  });
}
const dot = new THREE.Mesh(new THREE.SphereGeometry(0.005, 6, 6), new THREE.MeshBasicMaterial({ color: 0x00ff00 }));
const tmpDir = new THREE.Vector3();
scene.add(dot);

// fixed-step sim (60Hz) decoupled from render
const DT = 1 / CFG.tickHz;
// scratch for blast-vs-player (preallocated, no per-boom alloc)
const victim = { x: 0, y: 0, z: 0 };
const victims = [victim];
const blastPos = [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }];
const blastOut: BlastOut[] = [{ i: 0, dmg: 0 }];
let acc = 0, last = performance.now();
let fpsN = 0, fpsT = 0, fps = 0, ms = 0;
let leanK = 0; // smoothed lean -1..1

function frame(now: number): void {
  requestAnimationFrame(frame);
  let dt = (now - last) / 1000;
  last = now;
  if (dt > 0.25) dt = 0.25;
  fpsN++; fpsT += dt;
  if (fpsT >= 0.5) { fps = Math.round(fpsN / fpsT); ms = fpsT / fpsN * 1000; fpsN = 0; fpsT = 0; updateHud(); }

  consumeLook(input); // fold this frame's mouse in (capped), then read fresh
  yaw = input.yaw; pitch = input.pitch;
  const inMatch = match !== null;
  const inLan = lan !== null;
  const frozen = inMatch ? match!.playerFrozen() : inLan ? lan!.frozen() : false;
  const pDead = inMatch ? !match!.playerAlive() : inLan ? !lan!.amAlive() : dead;
  gun.acceptTrigger = !pDead && !frozen && !chatOpen;

  // round resets teleport the player (solo)
  if (inMatch && match!.playerTeleport) {
    match!.playerTeleport = false;
    const sp = match!.playerSpawn;
    player.x = sp.x; player.y = sp.y; player.z = sp.z;
    player.vx = player.vy = player.vz = 0;
    hp = match!.playerHp();
  }

  if (inLan) lan!.update(dt); // sends input @30Hz, records predict history
  if (inMatch) match!.setPlayerInteract(interactHeld);
  if (inLan) lan!.setInteract(interactHeld);

  // live playfield: solo/LAN matches mutate walls, walk mode uses the base map
  const wc = inMatch ? match!.world.colliders : inLan ? lan!.world.colliders : colliders;
  const wg = inMatch ? match!.world.grid : inLan ? lan!.world.grid : grid;

  acc += dt;
  let steps = 0;
  while (acc >= DT && steps < 4 && !pDead && !frozen) {
    stepPlayer(player, input, DT, wc, wg, gun.moveMul());
    acc -= DT; steps++;
  }
  if (pDead || frozen) acc = 0;
  gun.update(dt);
  if (inMatch) {
    // grenade blasts: boards + everyone (bots + you)
    const nb = gun.drainBlasts(blastPos);
    for (let i = 0; i < nb; i++) match!.applyBlast(blastPos[i].x, blastPos[i].y, blastPos[i].z);
    match!.syncPlayer(player.x, player.y, player.z, player.crouching);
    match!.update(dt);
  } else if (inLan) {
    // LAN nades live on the server; local balls never spawn (hooks redirect G)
    gun.drainBlasts(blastPos);
  } else {
    // grenade blasts hurt the player (boards handled inside the gun)
    const nb = gun.drainBlasts(blastPos);
    for (let i = 0; i < nb; i++) {
      victim.x = player.x; victim.y = player.y + 0.9; victim.z = player.z;
      const nv = blastDamage(blastPos[i].x, blastPos[i].y, blastPos[i].z, victims, colliders, blastOut);
      for (let k = 0; k < nv; k++) {
        const [left, alive] = hurt(hp, blastOut[k].dmg);
        hp = left;
        if (!alive && !dead) {
          dead = true;
          deadBox.style.display = 'flex';
          document.exitPointerLock?.();
        }
      }
    }
  }
  input.pitch += gun.consumeKick();
  if (input.pitch > 1.55) input.pitch = 1.55;
  pitch = input.pitch;

  if (inMatch && pDead) {
    match!.spectateCam(camera); // dead: watch an ally
  } else if (inLan && pDead) {
    lan!.spectateCam(camera);
  } else {
    const eye = player.crouching ? CFG.eyeCrouch : CFG.eyeStand;
    camera.position.set(player.x, player.y + eye, player.z);
    camera.rotation.set(0, 0, 0);
    camera.rotation.order = 'YXZ';
    camera.rotation.y = yaw;
    camera.rotation.x = pitch;
    // lean (Q/E hold): shift out + tilt in. Lerp keeps it smooth.
    leanK += Math.max(-dt * 8, Math.min(dt * 8, input.lean - leanK));
    camera.translateX(leanK * 0.4);
    camera.rotation.z = -leanK * 0.09;
  }

  // cross dot 1m ahead (helps aim check, reused temp, no alloc)
  camera.getWorldDirection(tmpDir);
  dot.position.copy(camera.position).addScaledVector(tmpDir, 1);

  if (inLan) lan!.render(); // interp'd remote bodies

  for (const b of walkBeacons) if (b.group.visible) b.tick(dt);

  renderer.render(scene, camera);
}

function updateHud(): void {
  const info = renderer.info.render;
  const showHp = match ? match.playerHp() : lan ? lan.myHp() : hp;
  const showDead = match ? !match.playerAlive() : lan ? !lan.amAlive() : dead;
  hud.textContent =
    `FPS ${fps}  ms ${ms.toFixed(1)}  draws ${info.calls}  tris ${info.triangles} (map ${mapTris})\n` +
    `pos ${player.x.toFixed(1)} ${player.y.toFixed(1)} ${player.z.toFixed(1)}  grounded ${player.grounded ? 1 : 0}\n` +
    `HP ${showHp}${showDead ? ' DEAD' : ''}${lan ? '  ' + lanPing : ''}\n` +
    `${gun.lastHit ? gun.lastHit + '\n' : ''}` +
    `colliders ${colliders.length}  debug F1:${debugOn ? 'ON' : 'off'}  ping --`;
}

requestAnimationFrame(frame);
