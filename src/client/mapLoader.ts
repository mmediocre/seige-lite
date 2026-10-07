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
  return VISUAL_PREFIX.some((p) => name.startsWith(p));
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

    if (name.startsWith('Col_')) {
      const kind = String(ex['collider'] ?? 'box');
      child.updateWorldMatrix(true, false);
      child.matrixWorld.decompose(tmpP, tmpQ, tmpS);
      if (kind === 'ramp') {
        colliders.push(buildRamp(child, tmpP));
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

    if (name.startsWith('Spawn_') || name.startsWith('Objective_')) {
      child.updateWorldMatrix(true, false);
      const p = new THREE.Vector3();
      child.getWorldPosition(p);
      markers[name] = p;
      continue; // empties, not rendered
    }

    if (name.startsWith('Reinforced_') || name.startsWith('Hatch_')) {
      paint(child);
      visuals.add(child);
      destructibles.push(child);
      // self-collider from bounding box (slot gap opens when removed in M6)
      const box = new THREE.Box3().setFromObject(child);
      slotBoxes.push({
        name, kind: name.startsWith('Hatch_') ? 'hatch' : 'wall',
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
    .filter((k) => k.startsWith('Objective_'))
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
