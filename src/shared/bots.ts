// Bot brains: shared + renderer-free. Same movement/shooting code as players.
// Tiny cost: heavy thinks (LOS, repath) run every 0.15s, staggered per bot.
import { CFG } from './config.js';
import { findPath, nearestNode, type NavGraph } from './nav.js';
import { WEAPONS } from './weapons.js';

export interface Ent {
  x: number; y: number; z: number;
  hp: number; alive: boolean; crouch: boolean;
  side: 'atk' | 'def';
}

export type Role = 'guardA' | 'guardB' | 'roam' | 'push';

export interface Bot {
  role: Role;
  yaw: number; pitch: number;
  mag: number; reloadT: number; shotT: number;
  react: number;          // counts down once an enemy is seen
  thinkT: number; repathT: number; stuckT: number;
  burstT: number; burstOn: boolean;
  strafe: number; strafeT: number;
  enemy: number;          // entity index or -1
  aimX: number; aimY: number; aimZ: number; // current aim point
  path: number[]; pathI: number; pathN: number;
  destX: number; destZ: number;
  lastX: number; lastZ: number;
  reactCfg: number; errCfg: number;
  gun: string; // weapon id
}

export function makeBot(role: Role, difficulty: 'recruit' | 'regular', stagger: number): Bot {
  const d = difficulty === 'recruit'
    ? { r: CFG.recruitReact, e: CFG.recruitErr }
    : { r: CFG.regularReact, e: CFG.regularErr };
  return {
    role, yaw: 0, pitch: 0, mag: 30, reloadT: 0, shotT: 0,
    react: 0, thinkT: stagger, repathT: 0, stuckT: 0,
    burstT: 0.5, burstOn: true, strafe: 0, strafeT: 0,
    enemy: -1, aimX: 0, aimY: 0, aimZ: 0,
    path: new Array(512).fill(0), pathI: 0, pathN: 0,
    destX: 0, destZ: 0, lastX: 0, lastZ: 0,
    reactCfg: d.r, errCfg: d.e, gun: 'ar',
  };
}

export interface BotCmd {
  yaw: number; pitch: number;
  fwd: boolean; back: boolean; left: boolean; right: boolean;
  crouch: boolean; jump: boolean;
  wantFire: boolean;
}

export interface BotCtx {
  nav: NavGraph;
  losClear: (x1: number, y1: number, z1: number, x2: number, y2: number, z2: number) => boolean;
  sites: { x: number; z: number }[]; // Objective_* sorted A-Z
  teamSite: number; // attackers' target site index this round
  holdAttacks: boolean; // prep: attackers wait
  freeze: boolean;      // prep: NOBODY walks or shoots (aim still tracks)
  rng: () => number;
}

// One think tick (call every frame; heavy work internally throttled).
// Fills cmd. entities[me] is this bot.
export function thinkBot(b: Bot, me: number, entities: Ent[], ctx: BotCtx, dt: number, cmd: BotCmd): void {
  const self = entities[me];
  cmd.jump = false;
  cmd.crouch = false;

  b.thinkT -= dt;
  if (b.thinkT <= 0) {
    b.thinkT = 0.15;
    thinkSlow(b, me, entities, ctx);
  }

  // frozen (prep countdown): stand still, no shooting — but keep looking
  if (ctx.freeze) {
    cmd.fwd = false; cmd.back = false; cmd.left = false; cmd.right = false;
    cmd.wantFire = false;
    if (b.enemy >= 0 && entities[b.enemy].alive) {
      const e = entities[b.enemy];
      const dx = b.aimX - self.x, dy = b.aimY - (self.y + 1.55), dz = b.aimZ - self.z;
      b.yaw = Math.atan2(-dx, -dz);
      const hl = Math.hypot(dx, dz) || 1;
      b.pitch = Math.atan2(dy, hl);
    }
    cmd.yaw = b.yaw;
    cmd.pitch = b.pitch;
    return;
  }

  // face: enemy first, else move direction
  if (b.enemy >= 0 && entities[b.enemy].alive) {
    const e = entities[b.enemy];
    const dx = b.aimX - self.x, dy = b.aimY - (self.y + 1.55), dz = b.aimZ - self.z;
    b.yaw = Math.atan2(-dx, -dz);
    const hl = Math.hypot(dx, dz) || 1;
    b.pitch = Math.atan2(dy, hl);
  } else if (b.pathI < b.pathN) {
    const wp = ctx.nav.nodes[b.path[b.pathI]];
    const dx = wp.x - self.x, dz = wp.z - self.z;
    if (dx * dx + dz * dz > 0.04) b.yaw = Math.atan2(-dx, -dz);
  }
  cmd.yaw = b.yaw;
  cmd.pitch = b.pitch;

  // walk the path (skip when engaging at close range)
  const engaging = b.enemy >= 0;
  cmd.fwd = false; cmd.back = false; cmd.left = false; cmd.right = false;
  if (!engaging && b.pathI < b.pathN) {
    const wp = ctx.nav.nodes[b.path[b.pathI]];
    const dx = wp.x - self.x, dz = wp.z - self.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.5) b.pathI++;
    else {
      // walk toward waypoint relative to facing
      const fx = -Math.sin(b.yaw), fz = -Math.cos(b.yaw);
      const along = (dx * fx + dz * fz) / (d || 1);
      const side = (-dz * fx + dx * fz) / (d || 1);
      cmd.fwd = along > 0.3;
      cmd.back = along < -0.3;
      cmd.right = side > 0.3;
      cmd.left = side < -0.3;
    }
  }
  // combat strafe drift
  if (engaging && b.strafe !== 0) {
    cmd.right = b.strafe > 0;
    cmd.left = b.strafe < 0;
  }

  // stuck? hop + repath
  b.stuckT += dt;
  if (b.stuckT > 1) {
    b.stuckT = 0;
    const moved = Math.hypot(self.x - b.lastX, self.z - b.lastZ);
    b.lastX = self.x; b.lastZ = self.z;
    const wantsMove = cmd.fwd || cmd.back || cmd.left || cmd.right;
    if (wantsMove && moved < 0.25) {
      cmd.jump = true;
      b.repathT = 0; // repath next think
    }
  }

  // trigger + rpm + reload
  cmd.wantFire = false;
  if (b.reloadT > 0) { b.reloadT -= dt; if (b.reloadT <= 0) b.mag = WEAPONS[b.gun].mag; }
  b.shotT -= dt;
  if (b.enemy >= 0 && b.react <= 0 && b.reloadT <= 0 && b.mag > 0) {
    b.burstT -= dt;
    if (b.burstT <= 0) { b.burstT = b.burstOn ? 0.4 + ctx.rng() * 0.4 : 0.5 + ctx.rng() * 0.5; b.burstOn = !b.burstOn; }
    if (b.burstOn && b.shotT <= 0) cmd.wantFire = true;
  }
}

function thinkSlow(b: Bot, me: number, entities: Ent[], ctx: BotCtx): void {
  const self = entities[me];
  // nearest visible enemy
  let best = -1, bd = 40 * 40;
  for (let i = 0; i < entities.length; i++) {
    if (i === me) continue;
    const e = entities[i];
    if (!e.alive || e.side === self.side) continue;
    const dx = e.x - self.x, dz = e.z - self.z;
    const d2 = dx * dx + dz * dz;
    if (d2 > bd) continue;
    const ey = e.y + (e.crouch ? 0.7 : 1.2);
    if (!ctx.losClear(self.x, self.y + 1.55, self.z, e.x, ey, e.z)) continue;
    bd = d2; best = i;
  }
  if (best !== b.enemy) {
    b.enemy = best;
    if (best >= 0) b.react = b.reactCfg; // spotted someone new: reaction delay
  }
  if (b.enemy >= 0) {
    const e = entities[b.enemy];
    if (!e.alive) { b.enemy = -1; }
    else {
      b.react -= 0.15;
      // aim at chest + fixed error per engagement (rerolled while engaging)
      const r = ctx.rng;
      b.aimX = e.x + (r() - 0.5) * 2 * b.errCfg * 10 * 0.35;
      b.aimY = e.y + (e.crouch ? 0.7 : 1.2) + (r() - 0.5) * 2 * b.errCfg * 10 * 0.25;
      b.aimZ = e.z + (r() - 0.5) * 2 * b.errCfg * 10 * 0.35;
      b.strafeT -= 0.15;
      if (b.strafeT <= 0) {
        b.strafeT = 1 + r() * 1.5;
        b.strafe = r() < 0.5 ? (r() < 0.5 ? -1 : 1) : 0;
      }
    }
  }
  // destination by role. One site is live per round, so ALL defenders work
  // it: guards take opposite sides of it, roamers drift around it.
  const first = ctx.sites[0] ?? { x: 0, z: 0 };
  const team = ctx.sites[ctx.teamSite] ?? first;
  let gx = team.x, gz = team.z;
  if (self.side === 'def') {
    if (b.role === 'guardA') { gx = team.x + 1.5; gz = team.z; }
    else if (b.role === 'guardB') { gx = team.x - 1.5; gz = team.z; }
    else {
      gx = team.x + (ctx.rng() - 0.5) * 8;
      gz = team.z + (ctx.rng() - 0.5) * 8;
    }
  } else {
    if (ctx.holdAttacks) { gx = self.x; gz = self.z; }
  }
  b.repathT -= 0.15;
  const arrived = Math.hypot(gx - self.x, gz - self.z) < 1.2;
  if (b.repathT <= 0 && !arrived) {
    b.repathT = 3;
    b.destX = gx; b.destZ = gz;
    b.pathN = findPath(ctx.nav, nearestNode(ctx.nav, self.x, self.y, self.z), nearestNode(ctx.nav, gx, self.y, gz), b.path);
    b.pathI = 0;
  }
  if (arrived) b.pathN = 0;
}
