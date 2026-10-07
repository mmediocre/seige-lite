// Player movement only (M1). Fixed-step, deterministic, no rendering imports.
import { CFG } from './config.js';
import { boxOverlaps, queryBox, rampHeightAt, rampHeightClamped, type Collider, type Grid } from './colliders.js';
import { clamp } from './math.js';

export interface Input {
  fwd: boolean; back: boolean; left: boolean; right: boolean;
  sprint: boolean; crouch: boolean; jump: boolean;
  yaw: number; // radians
}

export interface Player {
  x: number; y: number; z: number; // y = FEET
  vx: number; vy: number; vz: number;
  grounded: boolean;
  crouching: boolean;
}

export function makePlayer(x: number, y: number, z: number): Player {
  return { x, y, z, vx: 0, vy: 0, vz: 0, grounded: false, crouching: false };
}

// True when a player box at (feet x,y,z) overlaps nothing. Test/debug helper.
export function isFree(list: Collider[], grid: Grid, x: number, y: number, z: number, crouch = false): boolean {
  const r = CFG.playerRadius;
  const h = crouch ? CFG.playerHeightCrouch : CFG.playerHeightStand;
  return !hitsSolid(list, grid, x - r, y + 0.02, z - r, x + r, y + h, z + r, y);
}

const _cand: number[] = [];
for (let i = 0; i < 256; i++) _cand.push(0);
const _cand2: number[] = [];
for (let i = 0; i < 256; i++) _cand2.push(0);

function playerExtents(p: Player, crouch: boolean) {
  const r = CFG.playerRadius;
  const h = crouch ? CFG.playerHeightCrouch : CFG.playerHeightStand;
  return { r, h };
}

function hitsSolid(list: Collider[], grid: Grid,
  minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number,
  footY: number): boolean {
  // Collision skin: shrink the body box a touch so grazing a slab edge by
  // millimetres doesn't wedge you. Invisible (2cm), applied uniformly.
  const S = 0.02;
  minX += S; minY += S; minZ += S; maxX -= S; maxY -= S; maxZ -= S;
  const n = queryBox(grid, list, _cand, minX, minY, minZ, maxX, maxY, maxZ);
  for (let k = 0; k < n; k++) {
    const c = list[_cand[k]];
    if (c.kind === 'ramp') {
      // wedge: check the box actually touches it, then compare feet to the
      // surface height at the nearest point (low edge ~= walk in, tall = wall).
      // NOTE: local clamped height, NOT the lofty maxY — the wedge is ankle-
      // high at its foot and 3m at its head; maxY walled off the whole side.
      if (maxX <= c.minX || minX >= c.maxX || maxZ <= c.minZ || minZ >= c.maxZ ||
          maxY <= c.minY || minY >= c.maxY) continue;
      const h = rampHeightClamped(c, (minX + maxX) / 2, (minZ + maxZ) / 2);
      if (footY > h - 0.25) continue; // above the steps: free
      return true; // below the surface: solid wedge
    } else {
      if (boxOverlaps(c, minX, minY, minZ, maxX, maxY, maxZ)) return true;
    }
  }
  return false;
}

// Step onto low ledges (ramp->floor lip, door thresholds). Returns true if stepped.
function tryStepUp(p: Player, list: Collider[], grid: Grid, nx: number, nz: number, r: number, h: number): boolean {
  // find highest walkable top within step height at the target footprint
  const n = queryBox(grid, list, _cand, nx - r, p.y - 0.1, nz - r, nx + r, p.y + CFG.stepSnapUp + h, nz + r);
  let best = -Infinity;
  for (let k = 0; k < n; k++) {
    const col = list[_cand[k]];
    if (col.kind === 'ramp') {
      if (nx + r <= col.minX || nx - r >= col.maxX || nz + r <= col.minZ || nz - r >= col.maxZ) continue;
      const surf = rampHeightClamped(col, nx, nz);
      if (surf > p.y + 0.02 && surf <= p.y + CFG.stepSnapUp && surf > best) best = surf;
    } else if (col.maxX > nx - r && col.minX < nx + r && col.maxZ > nz - r && col.minZ < nz + r) {
      const top = col.maxY;
      if (top > p.y + 0.02 && top <= p.y + CFG.stepSnapUp && top > best) best = top;
    }
  }
  if (best === -Infinity) return false;
  // headroom check at lifted height
  if (hitsSolid(list, grid, nx - r, best + 0.05, nz - r, nx + r, best + h, nz + r, best)) return false;
  p.x = nx; p.z = nz; p.y = best;
  if (p.vy < 0) p.vy = 0;
  p.grounded = true;
  return true;
}

// One fixed step. Reuses no heap (module scratch only).
export function stepPlayer(p: Player, inp: Input, dt: number, list: Collider[], grid: Grid, speedMul = 1): void {
  // Auto-duck: if standing tall doesn't fit but crouching does (head under a
  // slab edge while climbing), duck for this tick. Brushing a wall doesn't
  // trigger it because the crouch box is blocked too. Frees all head wedges.
  let crouch = inp.crouch;
  if (!crouch) {
    const r = CFG.playerRadius, hs = CFG.playerHeightStand, hc = CFG.playerHeightCrouch;
    if (hitsSolid(list, grid, p.x - r, p.y + 0.02, p.z - r, p.x + r, p.y + hs, p.z + r, p.y) &&
        !hitsSolid(list, grid, p.x - r, p.y + 0.02, p.z - r, p.x + r, p.y + hc, p.z + r, p.y)) {
      crouch = true;
    }
  }
  p.crouching = crouch;
  const { r, h } = playerExtents(p, crouch);

  // wish dir from yaw ( -Z forward when yaw=0 to match three )
  const s = Math.sin(inp.yaw), c = Math.cos(inp.yaw);
  let wx = 0, wz = 0;
  if (inp.fwd) { wx += -s; wz += -c; }
  if (inp.back) { wx += s; wz += c; }
  if (inp.left) { wx += -c; wz += s; }
  if (inp.right) { wx += c; wz += -s; }
  const wl = Math.hypot(wx, wz);
  if (wl > 0) { wx /= wl; wz /= wl; }

  let speed = crouch ? CFG.crouchSpeed : inp.sprint ? CFG.sprintSpeed : CFG.walkSpeed;
  speed *= CFG.slopePenalty * speedMul; // tiny slope tax + weapon weight

  const tx = wx * speed, tz = wz * speed;
  const k = p.grounded ? CFG.accel * dt : CFG.accel * CFG.airControl * dt * 4;
  const kk = k > 1 ? 1 : k;
  p.vx += (tx - p.vx) * kk;
  p.vz += (tz - p.vz) * kk;

  if (inp.jump && p.grounded) { p.vy = CFG.jumpSpeed; p.grounded = false; }
  p.vy += CFG.gravity * dt;
  if (p.vy < -12) p.vy = -12;

  // --- X axis (ramp counts as solid here: feet below the steps = blocked,
  // feet above = walkable. Skipping it let players walk into/through the wedge.)
  {
    const nx = p.x + p.vx * dt;
    if (!hitsSolid(list, grid, nx - r, p.y + 0.05, p.z - r, nx + r, p.y + h, p.z + r, p.y)) p.x = nx;
    else if (!tryStepUp(p, list, grid, nx, p.z, r, h)) p.vx = 0;
  }
  // --- Z axis (same) ---
  {
    const nz = p.z + p.vz * dt;
    if (!hitsSolid(list, grid, p.x - r, p.y + 0.05, p.z - r + (nz - p.z), p.x + r, p.y + h, nz + r, p.y)) p.z = nz;
    else if (!tryStepUp(p, list, grid, p.x, nz, r, h)) p.vz = 0;
  }

  // --- ramp snap UP (before Y resolve): climbing ---
  let snappedRamp = false;
  {
    const n = queryBox(grid, list, _cand, p.x - r, p.y - 0.5, p.z - r, p.x + r, p.y + h, p.z + r);
    for (let k2 = 0; k2 < n; k2++) {
      const col = list[_cand[k2]];
      if (col.kind !== 'ramp') continue;
      const surf = rampHeightAt(col, p.x, p.z);
      if (Number.isNaN(surf)) continue;
      const dy = surf - p.y;
      if (dy > 0 && dy <= CFG.stepSnapUp + 0.35 && p.vy <= 0.1) {
        // make sure head fits after lift
        if (!hitsSolid(list, grid, p.x - r, surf + 0.05, p.z - r, p.x + r, surf + h, p.z + r, surf)) {
          p.y = surf; p.vy = 0; p.grounded = true; snappedRamp = true;
        }
      }
    }
  }

  // --- Y axis ---
  if (!snappedRamp) {
    const ny = p.y + p.vy * dt;
    if (p.vy <= 0) {
      // falling: check landing on box top or ramp surface
      let landY = -Infinity;
      const n = queryBox(grid, list, _cand, p.x - r, Math.min(p.y, ny) - 0.1, p.z - r, p.x + r, p.y + h, p.z + r);
      for (let k2 = 0; k2 < n; k2++) {
        const col = list[_cand[k2]];
        if (col.kind === 'ramp') {
          const surf = rampHeightAt(col, p.x, p.z);
          // land on the surface, or step UP onto it just above the feet
          // (hopping the bottom step must mount, not tunnel under it)
          if (!Number.isNaN(surf) && surf <= p.y + CFG.stepSnapUp && surf >= ny - CFG.stepSnapDown) {
            if (surf > landY) landY = surf;
          }
        } else {
          // must horizontally overlap and top be below old feet (with small grace)
          if (col.maxX > p.x - r && col.minX < p.x + r && col.maxZ > p.z - r && col.minZ < p.z + r) {
            const top = col.maxY;
            if (top <= p.y + 0.08 && top >= ny - 0.02 && top > landY) landY = top;
            // standing exactly on top (walking off check keeps us grounded via snap-down below)
          }
        }
      }
      if (landY > -Infinity) {
        // Never settle feet where the head doesn't fit (stair funnel with a
        // slab overhead). BOXES only: the wedge answers "solid" whenever feet
        // are under its surface, which vetoed legit ground landings next to
        // the stairs and dropped players through the floor. Wedge mounts are
        // still guarded by the snap-up headroom check above.
        // Denied while grounded: hold position (retreat always fits).
        let fits = true;
        const m = queryBox(grid, list, _cand, p.x - r, landY + 0.05, p.z - r, p.x + r, landY + h, p.z + r);
        for (let k4 = 0; k4 < m; k4++) {
          const col = list[_cand[k4]];
          if (col.kind === 'ramp') continue;
          // same 2cm skin as hitsSolid: grazing a wall must not veto the floor
          if (boxOverlaps(col, p.x - r + 0.02, landY + 0.07, p.z - r + 0.02, p.x + r - 0.02, landY + h - 0.02, p.z + r - 0.02)) {
            fits = false;
            break;
          }
        }
        if (fits) {
          p.y = landY; p.vy = 0; p.grounded = true;
        } else if (p.grounded) {
          p.vy = 0;
        } else { p.y = ny; p.grounded = false; }
      }
      else {
        // snap-down: stick to ground stepping down small drops (ramp descent)
        if (p.grounded) {
          const n2 = queryBox(grid, list, _cand, p.x - r, p.y - CFG.stepSnapDown, p.z - r, p.x + r, p.y + 0.05, p.z + r);
          let best = -Infinity;
          for (let k3 = 0; k3 < n2; k3++) {
            const col = list[_cand[k3]];
            if (col.kind === 'ramp') {
              const surf = rampHeightAt(col, p.x, p.z);
              if (!Number.isNaN(surf) && surf < p.y && p.y - surf <= CFG.stepSnapDown && surf > best) best = surf;
            } else if (col.maxX > p.x - r && col.minX < p.x + r && col.maxZ > p.z - r && col.minZ < p.z + r) {
              const top = col.maxY;
              if (top < p.y && p.y - top <= CFG.stepSnapDown && top > best) best = top;
            }
          }
          if (best > -Infinity) { p.y = best; p.vy = 0; p.grounded = true; }
          else { p.y = ny; p.grounded = false; }
        } else { p.y = ny; p.grounded = false; }
      }
      // head bump when moving up handled below; falling through check:
      if (!p.grounded) {
        if (hitsSolid(list, grid, p.x - r, ny + 0.02, p.z - r, p.x + r, ny + h, p.z + r, ny)) {
          // landed inside? push up to top
          p.y = ny; p.grounded = false;
        }
      }
    } else {
      // moving up: block on ceiling
      if (hitsSolid(list, grid, p.x - r, ny, p.z - r, p.x + r, ny + h, p.z + r, ny)) { p.vy = 0; }
      else { p.y = ny; p.grounded = false; }
    }
  }

  // Last resort: never end a tick embedded in solid (stair wedge, slab lips).
  // Lift onto the wedge surface when it fits, else push out along the
  // smallest overlap. Runs only when embedded, so it costs nothing normally.
  for (let iter = 0; iter < 3; iter++) {
    if (!hitsSolid(list, grid, p.x - r, p.y + 0.02, p.z - r, p.x + r, p.y + h, p.z + r, p.y)) break;
    if (!depenetrate(p, list, grid, r, h)) break;
  }

  // keep above kill plane
  if (p.y < -20) { p.y = 0; p.vy = 0; }
  void clamp;
}

// Pushes p out of solid. Returns true if it moved. No heap (module scratch).
function depenetrate(p: Player, list: Collider[], grid: Grid, r: number, h: number): boolean {
  // 1) under the wedge surface: mount it when the head fits there
  {
    const n = queryBox(grid, list, _cand, p.x - r, p.y - 0.5, p.z - r, p.x + r, p.y + h, p.z + r);
    for (let k = 0; k < n; k++) {
      const col = list[_cand[k]];
      if (col.kind !== 'ramp') continue;
      const surf = rampHeightAt(col, p.x, p.z);
      if (Number.isNaN(surf)) continue;
      if (p.y > surf - 0.25) continue; // not under it
      // headroom at the surface (boxes only into _cand2: the wedge is air up there)
      let fits = true;
      const m = queryBox(grid, list, _cand2, p.x - r, surf + 0.05, p.z - r, p.x + r, surf + h, p.z + r);
      for (let k2 = 0; k2 < m; k2++) {
        const c2 = list[_cand2[k2]];
        if (c2.kind === 'ramp') continue;
        if (boxOverlaps(c2, p.x - r + 0.02, surf + 0.07, p.z - r + 0.02, p.x + r - 0.02, surf + h - 0.02, p.z + r - 0.02)) {
          fits = false;
          break;
        }
      }
      if (fits) {
        p.y = surf; p.vy = 0; p.grounded = true;
        return true;
      }
    }
  }
  // 2) push out: gather exits (boxes + wedge strip faces), take the smallest
  //    one that actually lands free. Unverified pushes bounce between two
  //    solids in cracks narrower than the player. Rare path: plain arrays ok.
  const tAx: number[] = [];
  const tDir: number[] = [];
  const tDist: number[] = [];
  {
    const n = queryBox(grid, list, _cand, p.x - r, p.y, p.z - r, p.x + r, p.y + h, p.z + r);
    for (let k = 0; k < n; k++) {
      const c = list[_cand[k]];
      if (c.kind === 'ramp') {
        // only when truly under the surface; push out the nearest strip face
        const hgt = rampHeightClamped(c, p.x, p.z);
        if (p.y > hgt - 0.25) continue;
        const xOver = p.x - r < c.maxX && p.x + r > c.minX;
        const zOver = p.z - r < c.maxZ && p.z + r > c.minZ;
        if (xOver && zOver) {
          const faces = [
            [(p.x + r) - c.minX, 0, -1], [c.maxX - (p.x - r), 0, 1],
            [(p.z + r) - c.minZ, 2, -1], [c.maxZ - (p.z - r), 2, 1],
          ];
          for (let f = 0; f < 4; f++) {
            if (faces[f][0] > 0 && tDist.length < 16) {
              tAx.push(faces[f][1]); tDir.push(faces[f][2]); tDist.push(faces[f][0]);
            }
          }
        }
        continue;
      }
      // box: smallest exit along XYZ (only when truly overlapping)
      if (!(p.x - r < c.maxX && p.x + r > c.minX &&
            p.y < c.maxY && p.y + h > c.minY &&
            p.z - r < c.maxZ && p.z + r > c.minZ)) continue;
      const pens = [
        p.x + r - c.minX, c.maxX - (p.x - r), // -x, +x
        p.y + h - c.minY, c.maxY - p.y,       // -y, +y
        p.z + r - c.minZ, c.maxZ - (p.z - r), // -z, +z
      ];
      for (let a = 0; a < 6; a++) {
        if (pens[a] > 0 && tDist.length < 16) {
          tAx.push(a < 2 ? 0 : a < 4 ? 1 : 2);
          tDir.push(a % 2 === 0 ? -1 : 1);
          tDist.push(pens[a]);
        }
      }
    }
  }
  // smallest exit first (insertion sort, tiny)
  for (let i = 1; i < tDist.length; i++) {
    const ax = tAx[i], dr = tDir[i], dd = tDist[i];
    let j = i - 1;
    while (j >= 0 && tDist[j] > dd) {
      tAx[j + 1] = tAx[j]; tDir[j + 1] = tDir[j]; tDist[j + 1] = tDist[j];
      j--;
    }
    tAx[j + 1] = ax; tDir[j + 1] = dr; tDist[j + 1] = dd;
  }
  for (let i = 0; i < tDist.length; i++) {
    const push = tDist[i] + 0.02;
    const nx = p.x + (tAx[i] === 0 ? tDir[i] * push : 0);
    const ny = p.y + (tAx[i] === 1 ? tDir[i] * push : 0);
    const nz = p.z + (tAx[i] === 2 ? tDir[i] * push : 0);
    if (!hitsSolid(list, grid, nx - r, ny + 0.02, nz - r, nx + r, ny + h, nz + r, ny)) {
      p.x = nx; p.y = ny; p.z = nz;
      if (tAx[i] === 1 && tDir[i] > 0) { p.vy = 0; p.grounded = true; }
      return true;
    }
  }
  return false;
}
