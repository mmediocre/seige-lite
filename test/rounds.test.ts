import { CFG } from '../src/shared/config.js';
import { makeMatch, playerSideForRound, updateMatch } from '../src/shared/rounds.js';
import { mulberry32 } from '../src/shared/combat.js';

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) { pass++; console.log(`ok   ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${extra}`); }
}

const rng = mulberry32(9);

// 1. prep -> action on timer
{
  const m = makeMatch('atk', rng);
  check('starts in prep', m.phase === 'prep' && m.playerSide === 'atk');
  updateMatch(m, 'atk', rng, CFG.prepS + 0.1, 3, 3, 0, 0);
  check('prep -> action', m.phase === 'action', m.phase);
}

// 2. elimination wins the round
{
  const m = makeMatch('atk', rng);
  updateMatch(m, 'atk', rng, CFG.prepS + 0.1, 3, 3, 0, 0);
  updateMatch(m, 'atk', rng, 1, 2, 0, 0, 0);
  check('atk elim win', m.phase === 'roundEnd' && m.atkWins === 1, `${m.phase} ${m.atkWins}`);
  check('event says how', m.events.includes('atkWin:elim'), m.events.join(','));
  check('10s breather for loadout', Math.abs(m.t - CFG.roundEndS) < 0.01 && CFG.roundEndS === 10, `t=${m.t}`);
}

// 3. timeout = defenders
{
  const m = makeMatch('def', rng);
  updateMatch(m, 'def', rng, CFG.prepS + 0.1, 3, 3, 0, 0);
  updateMatch(m, 'def', rng, CFG.actionS + 0.1, 2, 2, 0, 0);
  check('timeout def win', m.defWins === 1 && m.events.includes('defWin:time'));
}

// 4. secure: contested pauses, uncontested wins
{
  const m = makeMatch('atk', rng);
  updateMatch(m, 'atk', rng, CFG.prepS + 0.1, 3, 3, 0, 0);
  updateMatch(m, 'atk', rng, 5, 3, 3, 1, 1); // contested: no progress
  check('contested pauses', m.secureT === 0, `${m.secureT}`);
  updateMatch(m, 'atk', rng, CFG.secureTime + 0.1, 3, 3, 2, 0);
  check('secure atk win', m.events.includes('atkWin:secure'), m.events.join(','));
}

// 5. rounds advance + sides swap after round 2 + match ends at 3 wins
{
  const m = makeMatch('atk', rng);
  check('round1 atk side', m.playerSide === 'atk');
  const step = () => {
    updateMatch(m, 'atk', rng, 99, 3, 3, 0, 0);           // skip prep
    updateMatch(m, 'atk', rng, 0.1, 3, 0, 0, 0);            // atk elims def
    updateMatch(m, 'atk', rng, 99, 3, 3, 0, 0);             // skip roundEnd
  };
  step();
  check('round2 same side', m.round === 2 && m.playerSide === 'atk', `r${m.round} ${m.playerSide}`);
  step();
  check('round3 swapped', m.round === 3 && m.playerSide === 'def', `r${m.round} ${m.playerSide}`);
  check('score 2-0', m.atkWins === 2 && m.defWins === 0);
  step();
  check('match ends at 3', m.phase === 'matchEnd' && m.events.includes('matchAtk'), `${m.phase} ${m.atkWins}-${m.defWins}`);
}

check('side swap helper', playerSideForRound('def', 1) === 'def' && playerSideForRound('def', 4) === 'atk');

// N-site maps: teamSite stays in range across rounds
{
  const m = makeMatch('atk', rng, undefined, 4);
  let ok = m.teamSite >= 0 && m.teamSite < 4;
  for (let i = 0; i < 8; i++) {
    updateMatch(m, 'atk', rng, 99, 3, 3, 0, 0);
    updateMatch(m, 'atk', rng, 0.1, 3, 0, 0, 0);
    if (m.phase === 'matchEnd') break;
    if (m.teamSite < 0 || m.teamSite >= 4) ok = false;
    updateMatch(m, 'atk', rng, 99, 3, 3, 0, 0);
  }
  check('4-site rotation in range', ok);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
