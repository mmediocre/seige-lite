// ONE config file for all tunable numbers (M1-M7 share this).
export const CFG = {
  // player body (metres)
  playerRadius: 0.35,
  playerHeightStand: 1.8,
  playerHeightCrouch: 1.1,
  eyeStand: 1.65,
  eyeCrouch: 1.0,

  // movement (m/s)
  walkSpeed: 4.2,
  sprintSpeed: 6.0,
  crouchSpeed: 2.1,
  accel: 40,          // how fast velocity chases wish dir
  airControl: 0.25,
  jumpSpeed: 4.6,
  gravity: -13.0,    // a bit snappy, keeps ramp grounded
  slopeMaxDeg: 45,   // walkable slope (ramp is exactly 45)
  slopePenalty: 0.95,// speed x on slope (tiny)
  stepSnapDown: 0.55,// stick to ground going down ramp/stairs
  stepSnapUp: 0.6,   // lift up ramp without jumping

  // sim
  tickHz: 60,
  gridCell: 2.0,     // uniform grid cell for colliders

  // render
  fov: 75,
  viewDistance: 60,
  fogColor: 0x87a0b8,
  bgColor: 0x87a0b8,

  // damage
  playerHp: 300,      // tripled: rifles ~1.1s to kill, no more instant sprays
  headshotMul: 2,

  // rounds (M4)
  prepS: 10,          // frozen countdown (bots hold, attackers wait)
  roundEndS: 10,      // breather between rounds (LAN loadout picks happen here)
  actionS: 180,       // attackers must secure or eliminate
  secureRadius: 2.5,  // metres around a site
  secureTime: 10,     // attacker seconds inside to win
  maxRounds: 5,
  winRounds: 3,       // first to 3
  swapAfterRound: 2,  // sides swap for rounds 3+

  // bots (M4): reaction seconds + aim error radians.
  // Enemies shoot a notch better than allies so your team doesn't stomp them.
  botsPerSide: 3,     // 3v3 with you: you + 2 allies vs 3
  recruitReact: 0.7,
  recruitErr: 0.10,
  regularReact: 0.4,
  regularErr: 0.05,
  allyReactMul: 1.4,  // your bots: slower + sloppier
  allyErrMul: 1.4,
  foeReactMul: 0.85,  // enemy bots: a touch sharper
  foeErrMul: 0.85,
} as const;
