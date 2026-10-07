// Round + match flow. Pure: feed it counts, read events. Server (M5) owns this.
// Host-tunable via RoundCfg (LAN lobby); solo uses CFG defaults.
import { CFG } from './config.js';

// Timers tick down by fractions (1/30, 1/60); floats can land on +1e-15 instead
// of exactly 0, which would stall a phase forever. Everything <= EPS counts.
const EPS = 1e-3;

export type Phase = 'prep' | 'action' | 'roundEnd' | 'matchEnd';
export type Side = 'atk' | 'def';

export interface RoundCfg {
  prepS: number;
  actionS: number;
  secureTime: number;
  maxRounds: number;
  winRounds: number;
  swapAfterRound: number;
}

export const DEFAULT_ROUND_CFG: RoundCfg = {
  prepS: CFG.prepS,
  actionS: CFG.actionS,
  secureTime: CFG.secureTime,
  maxRounds: CFG.maxRounds,
  winRounds: CFG.winRounds,
  swapAfterRound: CFG.swapAfterRound,
};

export interface Match {
  phase: Phase;
  t: number;            // seconds left in phase
  round: number;        // 1-based
  atkWins: number;
  defWins: number;
  playerSide: Side;     // which side YOU are on this round (swaps halfway)
  teamSite: number;     // index into the map's Objective_* list (sorted A-Z)
  sites: number;        // how many sites this map has
  secureT: number;      // secure progress seconds
  events: string[];     // drained by presenter each tick
}

export function playerSideForRound(chosen: Side, round: number, cfg: RoundCfg = DEFAULT_ROUND_CFG): Side {
  return round <= cfg.swapAfterRound ? chosen : (chosen === 'atk' ? 'def' : 'atk');
}

export function makeMatch(chosen: Side, rng: () => number, cfg: RoundCfg = DEFAULT_ROUND_CFG, sites = 2): Match {
  return {
    phase: 'prep', t: cfg.prepS, round: 1,
    atkWins: 0, defWins: 0,
    playerSide: playerSideForRound(chosen, 1, cfg),
    teamSite: Math.floor(rng() * Math.max(1, sites)),
    sites: Math.max(1, sites),
    secureT: 0, events: ['roundStart'],
  };
}

function endRound(m: Match, winner: Side, why: string, rng: () => number, cfg: RoundCfg): void {
  if (winner === 'atk') m.atkWins++;
  else m.defWins++;
  m.phase = 'roundEnd';
  m.t = CFG.roundEndS;
  m.events.push(winner === 'atk' ? `atkWin:${why}` : `defWin:${why}`);
  void rng;
  void cfg;
}

function nextRound(m: Match, chosen: Side, rng: () => number, cfg: RoundCfg): void {
  if (m.atkWins >= cfg.winRounds || m.defWins >= cfg.winRounds || m.round >= cfg.maxRounds) {
    m.phase = 'matchEnd';
    m.t = 0;
    m.events.push(m.atkWins > m.defWins ? 'matchAtk' : 'matchDef');
    return;
  }
  m.round++;
  m.playerSide = playerSideForRound(chosen, m.round, cfg);
  m.teamSite = Math.floor(rng() * m.sites);
  m.secureT = 0;
  m.phase = 'prep';
  m.t = cfg.prepS;
  m.events.push('roundStart');
}

// atkAlive/defAlive counts; site counts for the CURRENT teamSite.
export function updateMatch(m: Match, chosen: Side, rng: () => number, dt: number,
  atkAlive: number, defAlive: number, atkInSite: number, defInSite: number,
  cfg: RoundCfg = DEFAULT_ROUND_CFG): void {
  m.t -= dt;
  if (m.phase === 'prep') {
    if (m.t <= EPS) { m.phase = 'action'; m.t = cfg.actionS; m.events.push('actionStart'); }
    return;
  }
  if (m.phase === 'action') {
    if (atkAlive <= 0 && defAlive <= 0) { endRound(m, 'def', 'draw', rng, cfg); return; }
    if (defAlive <= 0) { endRound(m, 'atk', 'elim', rng, cfg); return; }
    if (atkAlive <= 0) { endRound(m, 'def', 'elim', rng, cfg); return; }
    // secure progress: attackers inside, no defenders contesting
    if (atkInSite > 0 && defInSite === 0) {
      m.secureT += dt;
      if (m.secureT >= cfg.secureTime) { endRound(m, 'atk', 'secure', rng, cfg); return; }
    }
    if (m.t <= EPS) { endRound(m, 'def', 'time', rng, cfg); return; }
    return;
  }
  if (m.phase === 'roundEnd') {
    if (m.t <= EPS) nextRound(m, chosen, rng, cfg);
  }
}
