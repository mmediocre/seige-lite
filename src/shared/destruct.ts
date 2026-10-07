// Destructible slots: reinforced walls + hatch. Shared rules, server-owned in LAN.
// Round starts OPEN (hole). Defenders reinforce in prep (instant, F).
// Attackers breach reinforced slots by holding F (2s). Unreinforced slots
// stay open all round (NOT destructible in v1). One side effect lives here:
// NONE — this only computes states; presenter adds/removes meshes+colliders.
import { CFG } from './config.js';

export type SlotKind = 'wall' | 'hatch';
export type SlotState = 'open' | 'reinforced' | 'breached';
export type Side = 'atk' | 'def';

export interface Slot {
  name: string;
  kind: SlotKind;
  // AABB of the closed panel (its own collider when reinforced)
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
  state: SlotState;
  hp: number; // reinforced panel health (50). Bullets + holding F drain it.
}

export const SLOT_HP = 100;
export const BREACH_S = 2.0; // hold-F seconds alone (100hp / 50 per s)
const BREACH_DPS = SLOT_HP / BREACH_S;
export const INTERACT_M = 2.4;

export function makeSlots(boxes: { name: string; kind: SlotKind; min: number[]; max: number[] }[]): Slot[] {
  return boxes.map((b) => ({
    name: b.name, kind: b.kind,
    minX: b.min[0], minY: b.min[1], minZ: b.min[2],
    maxX: b.max[0], maxY: b.max[1], maxZ: b.max[2],
    state: 'open', hp: 0,
  }));
}

export function resetSlots(slots: Slot[]): void {
  for (const s of slots) { s.state = 'open'; s.hp = 0; }
}

function near(s: Slot, x: number, y: number, z: number): boolean {
  const cx = (s.minX + s.maxX) / 2, cy = (s.minY + s.maxY) / 2, cz = (s.minZ + s.maxZ) / 2;
  const dx = x - cx, dy = (y + 0.9) - cy, dz = z - cz;
  return dx * dx + dy * dy + dz * dz < INTERACT_M * INTERACT_M;
}

// Defender taps F near an OPEN slot -> reinforced (full HP). Anytime in
// prep or action (1s cooldown enforced by presenter, not here). Returns slot.
export function tryReinforce(slots: Slot[], side: Side, phase: string, x: number, y: number, z: number): Slot | null {
  if (side !== 'def' || (phase !== 'prep' && phase !== 'action')) return null;
  for (const s of slots) {
    if (s.state === 'open' && near(s, x, y, z)) {
      s.state = 'reinforced';
      s.hp = SLOT_HP;
      return s;
    }
  }
  return null;
}

// Damage a reinforced panel (bullets). Returns the slot if it just breached.
export function damageSlot(slots: Slot[], name: string, dmg: number): Slot | null {
  for (const s of slots) {
    if (s.name !== name || s.state !== 'reinforced') continue;
    s.hp -= dmg;
    if (s.hp <= 0) {
      s.hp = 0;
      s.state = 'breached';
      return s;
    }
    return null;
  }
  return null;
}

// Which reinforced slot (if any) contains this hit point?
export function slotAtPoint(slots: Slot[], x: number, y: number, z: number): Slot | null {
  const t = 0.05;
  for (const s of slots) {
    if (s.state !== 'reinforced') continue;
    if (x > s.minX - t && x < s.maxX + t &&
        y > s.minY - t && y < s.maxY + t &&
        z > s.minZ - t && z < s.maxZ + t) return s;
  }
  return null;
}

// Attacker holds F near a REINFORCED slot in action: drains HP. Returns the
// slot the moment it breaches. Damage persists (letting go doesn't heal).
export function stepBreach(slots: Slot[], side: Side, phase: string, holding: boolean,
  x: number, y: number, z: number, dt: number): Slot | null {
  for (const s of slots) {
    if (s.state !== 'reinforced') continue;
    if (side === 'atk' && phase === 'action' && holding && near(s, x, y, z)) {
      s.hp -= BREACH_DPS * dt;
      if (s.hp <= 0) {
        s.hp = 0;
        s.state = 'breached';
        return s;
      }
    }
  }
  return null;
}

// What should the HUD show for F right now? (presenter calls each tick)
// Within reach (2.4m): the action. A bit further (4.5m): why it won't work.
export function interactHint(slots: Slot[], side: Side, phase: string, x: number, y: number, z: number): string {
  return hintAt(slots, side, phase, x, y, z, INTERACT_M) || hintAt(slots, side, phase, x, y, z, 4.5);
}

function hintAt(slots: Slot[], side: Side, phase: string, x: number, y: number, z: number, range: number): string {
  const actionable = range <= INTERACT_M + 0.01;
  for (const s of slots) {
    const cx = (s.minX + s.maxX) / 2, cy = (s.minY + s.maxY) / 2, cz = (s.minZ + s.maxZ) / 2;
    const dx = x - cx, dy = (y + 0.9) - cy, dz = z - cz;
    if (dx * dx + dy * dy + dz * dz >= range * range) continue;
    if (s.state === 'open' && side === 'def' && (phase === 'prep' || phase === 'action')) {
      return actionable ? 'F reinforce wall' : 'get closer to reinforce';
    }
    if (s.state === 'open' && side === 'def') return 'reinforce in-round only';
    if (s.state === 'open') return actionable ? 'open gap — push through' : 'open gap ahead';
    if (s.state === 'reinforced' && side === 'atk' && phase === 'action') {
      return actionable ? 'hold F breach' : 'get closer to breach';
    }
    if (s.state === 'reinforced' && side === 'atk') return 'breach when action starts';
    if (s.state === 'reinforced') return 'reinforced ✓';
    if (s.state === 'breached') return 'breached ✓';
  }
  return '';
}

void CFG;
