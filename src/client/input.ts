// Keyboard + pointer-lock mouse look. No alloc per frame.
// Mouse deltas accumulate and are consumed once per frame with a total cap:
// on slow machines a whole burst of mousemove events can land in one frame,
// which used to add up to full spins. Now one frame can never turn > ~16°.
import { getBind, getInvertY, getSens } from './bindings.js';export interface Look { yaw: number; pitch: number; }

export function makeInput() {
  return {
    fwd: false, back: false, left: false, right: false,
    sprint: false, crouch: false, jump: false,
    lean: 0, // -1 left (Q) .. +1 right (E), held
    yaw: 0, pitch: 0,
    keys: {} as Record<string, boolean>,
    mdx: 0, mdy: 0, // pending mouse pixels
    chatOpen: false, // typing: game keys frozen
  };
}
export type RawInput = ReturnType<typeof makeInput>;

const MAX_PX = 120; // per frame total (≈16° at sens 1)

export function bindInput(el: HTMLElement, st: RawInput): void {
  addEventListener('keydown', (e) => {
    if (st.chatOpen) return; // typing goes to the chat box, not the game
    st.keys[e.code] = true;
    refresh(st);
    if (e.code === 'Space') e.preventDefault();
  });
  addEventListener('keyup', (e) => { st.keys[e.code] = false; refresh(st); });

  el.addEventListener('click', () => {
    if (document.pointerLockElement !== el) el.requestPointerLock?.();
  });
  // Browsers sometimes report one huge jump when the lock engages/disengages.
  // Guard: short grace; everything else just accumulates for the frame cap.
  let graceUntil = 0;
  document.addEventListener('pointerlockchange', () => {
    if (document.pointerLockElement === el) {
      graceUntil = performance.now() + 150;
      st.mdx = 0; st.mdy = 0;
    }
  });
  addEventListener('mousemove', (e) => {
    if (document.pointerLockElement !== el) return;
    if (performance.now() < graceUntil) return;
    st.mdx += e.movementX;
    st.mdy += e.movementY;
  });
}

// Call once per frame: folds pending mouse into yaw/pitch, capped. No alloc.
export function consumeLook(st: RawInput): void {
  const sens = 0.0023 * getSens();
  const inv = getInvertY() ? 1 : -1;
  let dx = st.mdx, dy = st.mdy;
  st.mdx = 0; st.mdy = 0;
  if (dx > MAX_PX) dx = MAX_PX; else if (dx < -MAX_PX) dx = -MAX_PX;
  if (dy > MAX_PX) dy = MAX_PX; else if (dy < -MAX_PX) dy = -MAX_PX;
  st.yaw -= dx * sens;
  st.pitch += dy * sens * inv;
  const lim = 1.55;
  if (st.pitch > lim) st.pitch = lim;
  if (st.pitch < -lim) st.pitch = -lim;
}
function refresh(st: RawInput): void {
  const k = st.keys;
  const has = (a: string) => !!k[getBind(a)];
  st.fwd = has('fwd') || !!k['ArrowUp'];
  st.back = has('back') || !!k['ArrowDown'];
  st.left = has('left') || !!k['ArrowLeft'];
  st.right = has('right') || !!k['ArrowRight'];
  st.sprint = has('sprint');
  st.crouch = has('crouch') || !!k['KeyC'];
  st.jump = has('jump');
  st.lean = has('leanR') ? 1 : has('leanL') ? -1 : 0;
}

// Drop all held keys (used when opening chat so you stop walking).
export function clearKeys(st: RawInput): void {
  st.keys = {};
  refresh(st);
}
