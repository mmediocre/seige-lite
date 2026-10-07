import { damageSlot, makeSlots, resetSlots, slotAtPoint, stepBreach, tryReinforce } from '../src/shared/destruct.js';

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) { pass++; console.log(`ok   ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${extra}`); }
}

function slots() {
  return makeSlots([
    { name: 'Reinforced_L1_A', kind: 'wall' as const, min: [-3.1, 0, 0.5], max: [-2.9, 3, 2.5] },
    { name: 'Hatch_L2', kind: 'hatch' as const, min: [5, 3.0, 1.5], max: [6, 3.2, 2.5] },
  ]);
}
const DT = 1 / 30;

// defender reinforces in prep
{
  const s = slots();
  const r = tryReinforce(s, 'def', 'prep', -3, 0, 1.5);
  check('defender reinforces', !!r && s[0].state === 'reinforced');
}

// attacker cannot reinforce, defender cannot breach
{
  const s = slots();
  check('attacker cannot reinforce', tryReinforce(s, 'atk', 'prep', -3, 0, 1.5) === null && s[0].state === 'open');
  check('no prep breach', stepBreach(s, 'atk', 'prep', true, -3, 0, 1.5, 5) === null);
  tryReinforce(s, 'def', 'prep', -3, 0, 1.5);
  check('defender cannot breach', stepBreach(s, 'def', 'action', true, -3, 0, 1.5, 5) === null && s[0].state === 'reinforced');
}

// attacker holds F 2s in action -> breach (25 dps on 50hp)
{
  const s = slots();
  tryReinforce(s, 'def', 'prep', -3, 0, 1.5);
  let out = null;
  for (let i = 0; i < 70 && !out; i++) out = stepBreach(s, 'atk', 'action', true, -3, 0, 1.5, DT);
  check('hold breaches', !!out && s[0].state === 'breached', `t=${(70 * DT).toFixed(1)}`);
}

// damage persists (letting go doesn't heal), bullets finish the job
{
  const s = slots();
  tryReinforce(s, 'def', 'prep', -3, 0, 1.5);
  check('full hp on reinforce', s[0].hp === 100);
  for (let i = 0; i < 30; i++) stepBreach(s, 'atk', 'action', true, -3, 0, 1.5, DT);
  const mid = s[0].hp;
  stepBreach(s, 'atk', 'action', false, -3, 0, 1.5, DT);
  check('damage persists', s[0].state === 'reinforced' && s[0].hp === mid && mid < 50, `hp=${mid}`);
  const at = slotAtPoint(s, -3, 1.5, 1.5);
  check('hit maps to slot', at !== null && at.name === 'Reinforced_L1_A');
  const broke = damageSlot(s, 'Reinforced_L1_A', 999);
  check('bullets breach', !!broke && s[0].state === 'breached');
  check('open slots immune', slotAtPoint(s, -3, 1.5, 1.5) === null);
}

// defender can also reinforce mid-action (1s cooldown is presenter-side)
{
  const s = slots();
  const r = tryReinforce(s, 'def', 'action', -3, 0, 1.5);
  check('action reinforce works', !!r && s[0].state === 'reinforced' && s[0].hp === 100);
}

// reset reopens everything
{
  const s = slots();
  tryReinforce(s, 'def', 'prep', -3, 0, 1.5);
  resetSlots(s);
  check('reset opens all', s.every((q) => q.state === 'open'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
