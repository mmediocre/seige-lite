// Loads map_house.glb and splits it per the map convention.
// Visuals render as-is (re-skinned fullbright). Colliders never render.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { Collider } from '../shared/colliders.js';

export interface SlotBox {
  name: string;
  kind: 'wall' | 'hatch';
  min: number[]; max: number[];
}

export interface SiteDef {
  name: string;
  pos: THREE.Vector3;
}

export interface MapData {
  visuals: THREE.Object3D;
  colliders: Collider[];
  markers: Record<string, THREE.Vector3>;
  sites: SiteDef[]; // every Objective_* marker, sorted A-Z (attack one per round)
  destructibles: THREE.Object3D[];
  slotBoxes: SlotBox[]; // same order as destructibles (M6 slots)
  triCount: number;
}

const VISUAL_PREFIX = ['Static_', 'Props_', 'Ground'];

function isVisual(name: string): boolean {
  if (name === 'Ground') return true;
  return VISUAL_PREFIX.some((p) => hasTag(name, p));
}

// Tag match tolerant to a modeler namespace prefix ("Vl_Col_Wall_01").
// "_Tag" containment avoids false hits like "ColdRoom" for "Col_".
export function hasTag(name: string, tag: string): boolean {
  return name === tag || name.startsWith(tag) || name.includes('_' + tag);
}

// Marker lookup by base name: exact first, else any "Prefix_Base" match.
export function findMarker(markers: Record<string, THREE.Vector3>, base: string): THREE.Vector3 | null {
  if (markers[base]) return markers[base];
  const suffix = '_' + base;
  for (const k of Object.keys(markers)) {
    if (k.endsWith(suffix)) return markers[k];
  }
  return null;
}

// Site letter from "Objective_X_..." regardless of namespace prefix.
export function siteLetter(name: string): string {
  const i = name.indexOf('Objective_');
  if (i < 0 || i + 11 >= name.length) return '?';
  return name[i + 11];
}

export async function loadMap(url: string): Promise<MapData> {
  const gltf = await new GLTFLoader().loadAsync(url);
  return splitScene(gltf.scene);
}

// Same split, usable headless (tests) on an already-parsed scene.
export function splitScene(scene: THREE.Object3D): MapData {
  scene.updateMatrixWorld(true);
  const visuals = new THREE.Group();
  visuals.name = 'visuals';
  const colliders: Collider[] = [];
  const markers: Record<string, THREE.Vector3> = {};
  const destructibles: THREE.Object3D[] = [];
  const slotBoxes: SlotBox[] = [];
  let triCount = 0;

  // Fullbright: swap every visual material for unlit MeshBasicMaterial
  // keeping the baked flat colour.
  const paint = (obj: THREE.Object3D) => {
    obj.traverse((o: THREE.Object3D) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const geo = m.geometry as THREE.BufferGeometry;
      const idx = geo.getIndex();
      triCount += Math.round((idx ? idx.count : geo.getAttribute('position').count) / 3);
      const old = m.material as THREE.Material | THREE.Material[];
      const first = Array.isArray(old) ? old[0] : old;
      let color = new THREE.Color(0xffffff);
      const anyM = first as unknown as { color?: THREE.Color };
      if (anyM && anyM.color) color = anyM.color.clone();
      m.material = new THREE.MeshBasicMaterial({ color, fog: true });
    });
  };

  const tmpP = new THREE.Vector3();
  const tmpS = new THREE.Vector3();
  const tmpQ = new THREE.Quaternion();

  const pending: THREE.Object3D[] = [...scene.children];
  for (const child of pending) {
    const name: string = child.name || '';
    const ex = ((child as unknown as { userData?: Record<string, unknown> }).userData || {}) as Record<string, unknown>;

    if (hasTag(name, 'Col_')) {
      const kind = String(ex['collider'] ?? 'box');
      child.updateWorldMatrix(true, false);
      child.matrixWorld.decompose(tmpP, tmpQ, tmpS);
      if (kind === 'ramp') {
        colliders.push(buildRamp(child, tmpP));
      } else if (isWedgeMesh(child)) {
        // custom props lost in export (happened once): a wedge in Colliders
        // can only be a ramp — derive everything from its shape
        console.warn(`[map] ${name}: no collider props, deriving ramp from wedge shape`);
        colliders.push(buildRampFromShape(child));
      } else {
        // unit-cube convention: size = world scale
        const sx = Math.abs(tmpS.x), sy = Math.abs(tmpS.y), sz = Math.abs(tmpS.z);
        colliders.push({
          kind: 'box', name, group: groupOf(ex, name),
          minX: tmpP.x - sx / 2, minY: tmpP.y - sy / 2, minZ: tmpP.z - sz / 2,
          maxX: tmpP.x + sx / 2, maxY: tmpP.y + sy / 2, maxZ: tmpP.z + sz / 2,
        });
      }
      continue; // NEVER render colliders
    }

    if (hasTag(name, 'Spawn_') || hasTag(name, 'Objective_')) {
      child.updateWorldMatrix(true, false);
      const p = new THREE.Vector3();
      child.getWorldPosition(p);
      markers[name] = p;
      continue; // empties, not rendered
    }

    if (hasTag(name, 'Reinforced_') || hasTag(name, 'Hatch_')) {
      paint(child);
      visuals.add(child);
      destructibles.push(child);
      // self-collider from bounding box (slot gap opens when removed in M6)
      const box = new THREE.Box3().setFromObject(child);
      slotBoxes.push({
        name, kind: hasTag(name, 'Hatch_') ? 'hatch' : 'wall',
        min: [box.min.x, box.min.y, box.min.z],
        max: [box.max.x, box.max.y, box.max.z],
      });
      colliders.push({
        kind: 'box', name, group: 'wall',
        minX: box.min.x, minY: box.min.y, minZ: box.min.z,
        maxX: box.max.x, maxY: box.max.y, maxZ: box.max.z,
      });
      continue;
    }

    if (isVisual(name)) {
      paint(child);
      visuals.add(child);
      continue;
    }

    // Unknown root (shouldn't happen): keep if it has meshes, drop empties/lights.
    let hasMesh = false;
    child.traverse((o: THREE.Object3D) => { if ((o as THREE.Mesh).isMesh) hasMesh = true; });
    if (hasMesh) { paint(child); visuals.add(child); }
  }

  // sort slots by name so client + server agree on SNAP slot order
  const order = slotBoxes.map((_, i) => i).sort((a, b) => (slotBoxes[a].name < slotBoxes[b].name ? -1 : 1));
  const sortedMeshes = order.map((i) => destructibles[i]);
  const sortedBoxes = order.map((i) => slotBoxes[i]);
  const sites = Object.keys(markers)
    .filter((k) => hasTag(k, 'Objective_'))
    .sort()
    .map((name) => ({ name, pos: markers[name] }));

  return { visuals, colliders, markers, sites, destructibles: sortedMeshes, slotBoxes: sortedBoxes, triCount };
}

function groupOf(ex: Record<string, unknown>, name: string) {
  const g = String(ex['group'] ?? '');
  if (g === 'wall' || g === 'floor' || g === 'prop' || g === 'other') return g;
  if (name.includes('Floor') || name.includes('Ground')) return 'floor' as const;
  if (name.includes('Prop') || name.includes('Barrier')) return 'prop' as const;
  return 'other' as const;
}

// A Col_ mesh that is NOT the shared unit cube (8 unique verts) is a wedge
// ramp by convention — the only other collider shape we build.
function firstMesh(node: THREE.Object3D): THREE.Mesh | null {
  let found: THREE.Mesh | null = null;
  node.traverse((o: THREE.Object3D) => {
    if (!found && (o as THREE.Mesh).isMesh) found = o as THREE.Mesh;
  });
  return found;
}

function uniqueWorldVerts(mesh: THREE.Mesh): THREE.Vector3[] {
  mesh.updateWorldMatrix(true, false);
  const pos = (mesh.geometry as THREE.BufferGeometry).getAttribute('position') as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  const seen = new Map<string, THREE.Vector3>();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
    const k = `${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)}`;
    if (!seen.has(k)) seen.set(k, v.clone());
  }
  return [...seen.values()];
}

function isWedgeMesh(node: THREE.Object3D): boolean {
  const mesh = firstMesh(node);
  if (!mesh) return false;
  return uniqueWorldVerts(mesh).length === 6;
}

// Full geometric ramp derivation (no custom props needed): high edge = verts
// at max height, low edge = lowest verts farthest from it. Handles mirrors.
function buildRampFromShape(node: THREE.Object3D): Collider {
  const mesh = firstMesh(node)!;
  const pts = uniqueWorldVerts(mesh);
  let minY = Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const eps = 0.05;
  let hx = 0, hz = 0, hn = 0;
  for (const p of pts) {
    if (p.y >= maxY - eps) { hx += p.x; hz += p.z; hn++; }
  }
  hx /= Math.max(1, hn); hz /= Math.max(1, hn);
  let lx = 0, lz = 0, best = -1;
  for (const p of pts) {
    if (p.y > minY + eps) continue;
    const d = (p.x - hx) * (p.x - hx) + (p.z - hz) * (p.z - hz);
    if (d > best) { best = d; lx = p.x; lz = p.z; }
  }
  const dx = hx - lx, dz = hz - lz;
  const runAxis: 'x' | 'z' = Math.abs(dx) >= Math.abs(dz) ? 'x' : 'z';
  const runLow = runAxis === 'x' ? lx : lz;
  const runHigh = runAxis === 'x' ? hx : hz;
  const runLen = Math.abs(runHigh - runLow) || 1;
  const rise = maxY - minY;
  const slopeDeg = (Math.atan2(rise, runLen) * 180) / Math.PI;
  const box = new THREE.Box3().setFromObject(node);
  return {
    kind: 'ramp', name: node.name || 'Col_Ramp', group: 'ramp',
    minX: box.min.x, minY: box.min.y, minZ: box.min.z,
    maxX: box.max.x, maxY: box.max.y, maxZ: box.max.z,
    runAxis, runLow, runHigh, yLow: minY, yHigh: maxY, slopeDeg,
  };
}

// Derive ramp strip from its wedge geometry + Blender rise_axis.
// Blender dir (dx,dy,dz) -> three (dx,dz,-dy); extras win for DIRECTION,
// geometry (box extents vs rise/tan(slope)) VERIFIES the run axis.
function buildRamp(node: THREE.Object3D, center: THREE.Vector3): Collider {
  const box = new THREE.Box3().setFromObject(node);
  const ex = ((node as unknown as { userData?: Record<string, unknown> }).userData || {}) as Record<string, unknown>;
  const rise = String(ex['rise_axis'] ?? '+Y'); // Blender axes
  const slopeDeg = Number(ex['slope_deg'] ?? 45);
  // Blender -> three direction
  const m: Record<string, [number, number, number]> = {
    '+X': [1, 0, 0], '-X': [-1, 0, 0],
    '+Y': [0, 0, -1], '-Y': [0, 0, 1],
    '+Z': [0, 1, 0], '-Z': [0, -1, 0],
  };
  const dir = m[rise] ?? [0, 0, -1];
  const riseLen = box.max.y - box.min.y;
  const runLen = riseLen / Math.tan((slopeDeg * Math.PI) / 180);
  const exX = box.max.x - box.min.x, exZ = box.max.z - box.min.z;
  // axis check: horizontal extent should match run length
  let runAxis: 'x' | 'z' = Math.abs(exX - runLen) < Math.abs(exZ - runLen) ? 'x' : 'z';
  // direction check: extras' dominant horizontal axis wins if it matches geometry
  const dom: 'x' | 'z' = Math.abs(dir[0]) >= Math.abs(dir[2]) ? 'x' : 'z';
  if (Math.abs((dom === 'x' ? exX : exZ) - runLen) < 0.3) runAxis = dom;
  const d = runAxis === 'x' ? dir[0] : dir[2]; // +1: rises toward max end
  const runLow = d >= 0 ? (runAxis === 'x' ? box.min.x : box.min.z)
                        : (runAxis === 'x' ? box.max.x : box.max.z);
  const runHigh = d >= 0 ? (runAxis === 'x' ? box.max.x : box.max.z)
                         : (runAxis === 'x' ? box.min.x : box.min.z);
  void center;
  return {
    kind: 'ramp', name: node.name || 'Col_Ramp_Stairs', group: 'ramp',
    minX: box.min.x, minY: box.min.y, minZ: box.min.z,
    maxX: box.max.x, maxY: box.max.y, maxZ: box.max.z,
    runAxis, runLow, runHigh, yLow: box.min.y, yHigh: box.max.y, slopeDeg,
  };
}
