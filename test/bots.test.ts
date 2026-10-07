import { CFG } from '../src/shared/config.js';
import { rayVsEntity } from '../src/shared/combat.js';
import { makeBot, thinkBot, type BotCmd, type BotCtx, type Ent } from '../src/shared/bots.js';
import type { NavGraph } from '../src/shared/nav.js';

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) { pass++; console.log(`ok   ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${extra}`); }
}

// entity hitboxes
{
  // chest shot at 5m
  const h = rayVsEntity(0, 1.0, 10, 0, 0, -1, 0, 0, 5, false, 20);
  check('body hit', !!h && !h.head && Math.abs(h.dist - 5) < 0.6, h ? `${h.dist.toFixed(2)} head=${h.head}` : 'null');
  // head shot: aim at head height
  const h2 = rayVsEntity(0, 1.55, 10, 0, 0, -1, 0, 0, 5, false, 20);
  check('head hit', !!h2 && h2.head, h2 ? `head=${h2.head}` : 'null');
  // clean miss
  check('miss', rayVsEntity(0, 5, 10, 0, 0, -1, 0, 0, 5, false, 20) === null);
}

// fake 3-node nav for brain tests
const nav: NavGraph = {
  nodes: [{ x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }, { x: 4, y: 0, z: 0 }],
  adj: [[1], [0, 2], [1]],
  minX: 0, minZ: 0, step: 1, nx: 1, nz: 1,
  cellNode: new Int32Array(0),
};
function ctx(): BotCtx {
  return {
    nav, losClear: () => true,
    sites: [{ x: 4, z: 0 }, { x: -4, z: 0 }],
    teamSite: 0, holdAttacks: false, freeze: false, rng: Math.random,
  };
}
function cmd(): BotCmd {
  return { yaw: 0, pitch: 0, fwd: false, back: false, left: false, right: false, crouch: false, jump: false, wantFire: false };
}

// bot spots an enemy ahead: reacts, aims, fires
{
  const b = makeBot('push', 'recruit', 0);
  const ents: Ent[] = [
    { x: 0, y: 0, z: 0, hp: 100, alive: true, crouch: false, side: 'atk' },
    { x: 0, y: 0, z: -10, hp: 100, alive: true, crouch: false, side: 'def' },
  ];
  const c = cmd();
  let fired = false;
  for (let i = 0; i < 40; i++) { thinkBot(b, 0, ents, ctx(), 0.05, c); if (c.wantFire) fired = true; }
  check('sees enemy', b.enemy === 1, `enemy=${b.enemy}`);
  check('faces enemy', Math.abs(c.yaw) < 0.2, `yaw=${c.yaw.toFixed(2)}`);
  check('opens fire after reaction', fired && b.react <= 0, `react=${b.react.toFixed(2)}`);
}

// no enemy: walks its path
{
  const b = makeBot('push', 'recruit', 0);
  const ents: Ent[] = [
    { x: 0, y: 0, z: 0, hp: 100, alive: true, crouch: false, side: 'atk' },
  ];
  const c = cmd();
  for (let i = 0; i < 10; i++) thinkBot(b, 0, ents, ctx(), 0.05, c);
  check('paths without enemy', b.pathN > 0 && (c.fwd || c.right), `pathN=${b.pathN} fwd=${c.fwd} right=${c.right}`);
  check('holds fire without enemy', !c.wantFire);
}

// frozen (prep countdown): stands still, never shoots, but still looks
{
  const b = makeBot('guardA', 'recruit', 0);
  const ents: Ent[] = [
    { x: 0, y: 0, z: 0, hp: 100, alive: true, crouch: false, side: 'def' },
    { x: 0, y: 0, z: -10, hp: 100, alive: true, crouch: false, side: 'atk' },
  ];
  const c = cmd();
  const cx = ctx();
  cx.freeze = true;
  let moved = false, fired = false;
  for (let i = 0; i < 40; i++) {
    thinkBot(b, 0, ents, cx, 0.05, c);
    if (c.fwd || c.back || c.left || c.right || c.jump) moved = true;
    if (c.wantFire) fired = true;
  }
  check('freeze holds movement', !moved);
  check('freeze holds fire', !fired);
  check('frozen bot still faces enemy', Math.abs(c.yaw) < 0.2, `yaw=${c.yaw.toFixed(2)}`);
}

// defenders converge on the ONE live site (nobody guards dead sites)
{
  const mk = (role: any) => {
    const b = makeBot(role, 'recruit', 0);
    const ents: Ent[] = [{ x: 0, y: 0, z: 0, hp: 100, alive: true, crouch: false, side: 'def' }];
    const c = cmd();
    const cx = ctx();
    cx.teamSite = 1; // live site is (-4, 0)
    for (let i = 0; i < 10; i++) thinkBot(b, 0, ents, cx, 0.05, c);
    return b;
  };
  const a = mk('guardA'), g = mk('guardB'), r = mk('roam');
  const nearLive = (b: any) => Math.hypot(b.destX - -4, b.destZ - 0) < 5;
  check('all defenders work the live site', nearLive(a) && nearLive(g) && nearLive(r),
    `A=(${a.destX.toFixed(1)},${a.destZ.toFixed(1)}) B=(${g.destX.toFixed(1)},${g.destZ.toFixed(1)})`);
}

void CFG;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
