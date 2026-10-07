import { decChat, decFeed, decFire, decHello, decHit, decInput, decLobby, decSnap, decWelcome, encBoom, decBoom, encChat, encFeed, encFire, encHello, encHit, encInput, encLobby, encSnap, encWelcome, type EntSnap } from '../src/shared/net.js';
import { History } from '../src/shared/history.js';

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) { pass++; console.log(`ok   ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${extra}`); }
}
function near(a: number, b: number, e = 0.02): boolean { return Math.abs(a - b) <= e; }

// hello roundtrip (unicode name too)
{
  const h = decHello(encHello('Jäger-7', 1, 3).slice(0));
  check('hello', h.name === 'Jäger-7' && h.side === 1 && h.gun === 3, JSON.stringify(h));
}

// input roundtrip
{
  const m = decInput(encInput({ seq: 4321, yaw: 1.234, pitch: -0.5, btn: 137, ads: 1 }).slice(0));
  check('input', m.seq === 4321 && near(m.yaw, 1.234, 0.001) && near(m.pitch, -0.5, 0.001) && m.btn === 137 && m.ads === 1);
}

// fire roundtrip
{
  const m = decFire(encFire({ seq: 9, tick: 123456, yaw: 0, pitch: 0, gun: 2 }).slice(0));
  check('fire', m.seq === 9 && m.tick === 123456 && m.gun === 2);
}

// snapshot roundtrip incl. quantisation
{
  const ents = [
    { id: 0, x: -3.25, y: 0.1, z: 14.5, yaw: 3.14, hp: 300, alive: true, crouch: false, side: 0, gun: 2 },
    { id: 5, x: 8.0, y: 3.2, z: -7.5, yaw: -1.5, hp: 37, alive: true, crouch: true, side: 1, gun: 4 },
  ];
  const out: EntSnap[] = [];
  const s = decSnap(encSnap({ tick: 999, phase: 1, phaseT: 12.5, round: 2, atkWins: 1, defWins: 0, teamSite: 1, secureT: 3.3, ack: 77, slots: [1, 0, 2, 0, 1], slotHp: [50, 0, 12, 0, 50], ents }).slice(0), out);
  check('snap header', s.tick === 999 && s.phase === 1 && s.round === 2 && s.ack === 77 && near(s.secureT, 3.3, 0.01));
  check('snap slots', s.slots.join(',') === '1,0,2,0,1' && s.slotHp.join(',') === '50,0,12,0,50', s.slots.join(',') + ' / ' + s.slotHp.join(','));
  check('snap ents', out.length === 2 && near(out[0].x, -3.25) && out[0].hp === 300 && near(out[1].z, -7.5) && out[1].hp === 37 && out[1].crouch && out[1].gun === 4, JSON.stringify(out[1]));
}

// hit + boom + lobby
{
  const h = decHit(encHit({ shooter: 2, victim: 5, dmg: 26, head: true, kill: false }));
  check('hit', h.shooter === 2 && h.dmg === 26 && h.head && !h.kill);
  const bo = decBoom(encBoom(1.5, 0.5, -2.5));
  check('boom', near(bo.x, 1.5, 0.001) && near(bo.z, -2.5, 0.001));
  const lp = [{ id: 0, name: 'Host', side: 0, host: true }, { id: 1, name: 'Jäger', side: 1, host: false }];
  const lob = decLobby(encLobby(lp, { bestOf: 3, prepS: 5, lock: true, stay: false, map: 2 }).slice(0));
  check('lobby', lob.players.length === 2 && lob.players[1].name === 'Jäger' && lob.players[0].host && lob.players[1].side === 1);
  check('lobby settings', lob.settings.bestOf === 3 && lob.settings.prepS === 5 && lob.settings.lock && !lob.settings.stay && lob.settings.map === 2);
  check('feed', decFeed(encFeed('P2 → DEF')) === 'P2 → DEF');
  const w = decWelcome(encWelcome(3, 'Player_2'));
  check('welcome id+name', w.id === 3 && w.name === 'Player_2');
  const c = decChat(encChat(2, 'gl hf!'));
  check('chat', c.sender === 2 && c.text === 'gl hf!');
}

// history: record + rewind
{
  const h = new History(8, 2);
  const mk = (x: number) => [{ x, y: 0, z: 0, crouch: false, alive: true }, { x: 9, y: 0, z: 0, crouch: false, alive: true }];
  for (let t = 100; t < 108; t++) h.record(t, mk(t));
  const out = [{ x: 0, y: 0, z: 0, crouch: false, alive: true }, { x: 0, y: 0, z: 0, crouch: false, alive: true }];
  const found = h.at(104, out);
  check('rewind exact', found === 104 && out[0].x === 104, `t=${found} x=${out[0].x}`);
  const found2 = h.at(999, out);
  check('rewind clamps newest', found2 === 107 && out[0].x === 107, `t=${found2}`);
  const found3 = h.at(50, out);
  check('rewind clamps oldest', found3 === 100, `t=${found3}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
