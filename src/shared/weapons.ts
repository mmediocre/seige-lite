// SINGLE weapon data table. All numbers live here — no stats hardcoded elsewhere.
// M2 uses the primaries; secondary + grenade entries are wired in M3.
export type Slot = 'primary' | 'secondary' | 'gadget';

export interface WeaponDef {
  id: string;
  slot: Slot;
  name: string;
  auto: boolean;      // hold trigger vs click per shot
  rpm: number;        // rounds per minute (fire interval = 60/rpm)
  mag: number;        // shots per reload
  reloadS: number;    // reload time, seconds
  damage: number;     // per pellet, inside falloff.near
  pellets: number;    // 1 for rifles, 8 for shotgun
  spreadHip: number;  // radians, cone half-angle from the hip
  falloffNear: number;// metres: full damage inside this
  falloffFar: number; // metres: minDamage beyond this
  minDamage: number;  // per pellet at/beyond falloffFar
  kick: number;       // radians added to pitch per shot (tiny, no pattern)
  movePenalty: number;// x move speed while held (1 = none)
}

export const WEAPONS: Record<string, WeaponDef> = {
  // --- PRIMARIES (M2) ---
  ar: {
    id: 'ar', slot: 'primary', name: 'Assault rifle',
    auto: true, rpm: 600, mag: 30, reloadS: 2.2,
    damage: 26, pellets: 1, spreadHip: 0.012,
    falloffNear: 20, falloffFar: 50, minDamage: 15,
    kick: 0.0035, movePenalty: 0.92,
  },
  smg: {
    id: 'smg', slot: 'primary', name: 'SMG',
    auto: true, rpm: 900, mag: 33, reloadS: 2.0,
    damage: 16, pellets: 1, spreadHip: 0.020,
    falloffNear: 10, falloffFar: 30, minDamage: 8,
    kick: 0.0022, movePenalty: 0.96,
  },
  shotgun: {
    id: 'shotgun', slot: 'primary', name: 'Shotgun',
    auto: false, rpm: 75, mag: 6, reloadS: 2.8,
    damage: 9, pellets: 8, spreadHip: 0.055,
    falloffNear: 6, falloffFar: 18, minDamage: 1,
    kick: 0.012, movePenalty: 0.9,
  },
  // --- SECONDARIES (M3) ---
  pistol: {
    id: 'pistol', slot: 'secondary', name: 'Pistol',
    auto: false, rpm: 400, mag: 15, reloadS: 1.6,
    damage: 40, pellets: 1, spreadHip: 0.010,
    falloffNear: 15, falloffFar: 40, minDamage: 22,
    kick: 0.003, movePenalty: 1.0,
  },
  machinepistol: {
    id: 'machinepistol', slot: 'secondary', name: 'Machine pistol',
    auto: true, rpm: 800, mag: 20, reloadS: 1.9,
    damage: 10, pellets: 1, spreadHip: 0.028,
    falloffNear: 8, falloffFar: 25, minDamage: 5,
    kick: 0.0032, movePenalty: 0.98,
  },
};

// Grenade slot: fixed 2 charges, data-driven for future flashbang/smoke.
export interface GadgetDef {
  id: string; name: string; charges: number;
  fuseS: number; damage: number; radius: number;
}
export const GADGETS: Record<string, GadgetDef> = {
  frag: { id: 'frag', name: 'Frag grenade', charges: 2, fuseS: 3.0, damage: 120, radius: 6 },
};

export const PRIMARIES = ['ar', 'smg', 'shotgun'] as const;
