// Changeable keybinds + mouse settings. Persisted in localStorage.
// Everything gameplay reads keys through here (input, weapon, main).
export interface ActionDef { id: string; label: string; def: string }

export const ACTIONS: ActionDef[] = [
  { id: 'fwd', label: 'Move forward', def: 'KeyW' },
  { id: 'back', label: 'Move back', def: 'KeyS' },
  { id: 'left', label: 'Strafe left', def: 'KeyA' },
  { id: 'right', label: 'Strafe right', def: 'KeyD' },
  { id: 'sprint', label: 'Sprint', def: 'ShiftLeft' },
  { id: 'crouch', label: 'Crouch', def: 'ControlLeft' },
  { id: 'jump', label: 'Jump', def: 'Space' },
  { id: 'leanL', label: 'Lean left', def: 'KeyQ' },
  { id: 'leanR', label: 'Lean right', def: 'KeyE' },
  { id: 'slotPri', label: 'Main weapon', def: 'Digit1' },
  { id: 'slotSec', label: 'Pistol', def: 'Digit2' },
  { id: 'reload', label: 'Reload', def: 'KeyR' },
  { id: 'nade', label: 'Frag grenade', def: 'KeyG' },
  { id: 'interact', label: 'Use (F)', def: 'KeyF' },
  { id: 'score', label: 'Scoreboard', def: 'Tab' },
  { id: 'chat', label: 'Chat (LAN)', def: 'KeyT' },
  { id: 'hideUI', label: 'Hide interface', def: 'KeyH' },
  { id: 'quit', label: 'Quit match', def: 'KeyM' },
  { id: 'debug', label: 'Collider boxes', def: 'F1' },
];

const KEY = 'siege-lite-binds-v1';

interface Store { binds: Record<string, string>; sens: number; invertY: boolean }
let cache: Store | null = null;

function defaults(): Store {
  const binds: Record<string, string> = {};
  for (const a of ACTIONS) binds[a.id] = a.def;
  return { binds, sens: 1, invertY: false };
}

function load(): Store {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<Store>;
      const d = defaults();
      cache = {
        binds: { ...d.binds, ...(p.binds || {}) },
        sens: typeof p.sens === 'number' ? Math.min(3, Math.max(0.2, p.sens)) : 1,
        invertY: !!p.invertY,
      };
      return cache;
    }
  } catch { /* private mode / headless: defaults */ }
  cache = defaults();
  return cache;
}

function save(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(cache ?? defaults()));
  } catch { /* ignore */ }
}

export function getBind(action: string): string {
  const s = load();
  return s.binds[action] ?? ACTIONS.find((a) => a.id === action)?.def ?? '';
}

export function setBind(action: string, code: string): void {
  const s = load();
  // steal: clear the same key from any other action first
  for (const k of Object.keys(s.binds)) {
    if (k !== action && s.binds[k] === code) s.binds[k] = '';
  }
  s.binds[action] = code;
  save();
}

export function resetBinds(): void {
  cache = defaults();
  save();
}

export function getSens(): number { return load().sens; }
export function setSens(n: number): void {
  load().sens = Math.min(3, Math.max(0.2, n));
  save();
}
export function getInvertY(): boolean { return load().invertY; }
export function setInvertY(b: boolean): void {
  load().invertY = b;
  save();
}

// "KeyW" -> "W", "Digit1" -> "1", "ShiftLeft" -> "Shift", "" -> "—"
export function labelFor(code: string): string {
  if (!code) return '—';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code === 'Space') return 'Space';
  if (code === 'Tab') return 'Tab';
  if (code === 'Escape') return 'Esc';
  if (code.endsWith('Left')) return code.slice(0, -4);
  if (code.endsWith('Right')) return code.slice(0, -5);
  if (code.startsWith('Arrow')) return code.slice(5);
  if (code.startsWith('F') && /^F\d+$/.test(code)) return code;
  return code;
}
