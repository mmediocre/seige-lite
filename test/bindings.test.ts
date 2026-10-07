import { ACTIONS, getBind, getInvertY, getSens, labelFor, resetBinds, setBind, setInvertY, setSens } from '../src/client/bindings.js';

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) { pass++; console.log(`ok   ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${extra}`); }
}

check('defaults cover actions', ACTIONS.length >= 15 && getBind('fwd') === 'KeyW' && getBind('interact') === 'KeyF');
setBind('fwd', 'KeyU');
check('rebind sticks', getBind('fwd') === 'KeyU');
setBind('back', 'KeyU'); // steal: back takes it, fwd loses it
check('steal clears loser', getBind('back') === 'KeyU' && getBind('fwd') === '');
resetBinds();
check('reset restores', getBind('fwd') === 'KeyW' && getBind('back') === 'KeyS');
setSens(2.5);
check('sens clamps+writes', getSens() === 2.5);
setSens(99);
check('sens clamps high', getSens() === 3);
setSens(1);
setInvertY(true);
check('invert toggles', getInvertY() === true);
setInvertY(false);
check('labels pretty', labelFor('KeyW') === 'W' && labelFor('Digit1') === '1' && labelFor('ShiftLeft') === 'Shift' && labelFor('Space') === 'Space' && labelFor('') === '—');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
