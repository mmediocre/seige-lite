// Tiny vector helpers that NEVER allocate in hot paths.
// Caller passes `out` objects to reuse.
export interface V3 { x: number; y: number; z: number; }

export function v3(x = 0, y = 0, z = 0): V3 { return { x, y, z }; }

// scratch pool (safe because JS is single-threaded here)
const _a: V3 = { x: 0, y: 0, z: 0 };
export function scratch(): V3 { _a.x = 0; _a.y = 0; _a.z = 0; return _a; }

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
