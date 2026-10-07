// Position history ring buffer for lag-compensated hitscan (server side).
// Records entity feet every tick; shooters rewind to their view tick.
export interface HistEnt { x: number; y: number; z: number; crouch: boolean; alive: boolean }

export class History {
  private ticks: Int32Array;
  private data: Float32Array; // [slot * maxEnt * 5 + ent * 5]: x,y,z,crouch,alive
  private head = -1;
  constructor(private slots: number, private maxEnt: number) {
    this.ticks = new Int32Array(slots).fill(-1);
    this.data = new Float32Array(slots * maxEnt * 5);
  }

  clear(): void {
    this.ticks.fill(-1);
  }

  record(tick: number, ents: HistEnt[]): void {
    this.head = (this.head + 1) % this.slots;
    this.ticks[this.head] = tick;
    const base = this.head * this.maxEnt * 5;
    for (let i = 0; i < ents.length && i < this.maxEnt; i++) {
      const e = ents[i];
      this.data[base + i * 5] = e.x;
      this.data[base + i * 5 + 1] = e.y;
      this.data[base + i * 5 + 2] = e.z;
      this.data[base + i * 5 + 3] = e.crouch ? 1 : 0;
      this.data[base + i * 5 + 4] = e.alive ? 1 : 0;
    }
    // stale-mark the rest
    for (let i = ents.length; i < this.maxEnt; i++) this.data[base + i * 5 + 4] = 0;
  }

  // Copy slot for `tick` into out (nearest tick <= asked, else oldest). Returns found tick.
  at(tick: number, out: HistEnt[]): number {
    let best = -1, bestTick = -1;
    for (let s = 0; s < this.slots; s++) {
      const t = this.ticks[s];
      if (t < 0 || t > tick) continue;
      if (t > bestTick) { bestTick = t; best = s; }
    }
    if (best < 0) {
      // nothing that old: use oldest available
      for (let s = 0; s < this.slots; s++) {
        const t = this.ticks[s];
        if (t >= 0 && (bestTick < 0 || t < bestTick)) { bestTick = t; best = s; }
      }
    }
    if (best < 0) return -1;
    const base = best * this.maxEnt * 5;
    for (let i = 0; i < out.length && i < this.maxEnt; i++) {
      out[i].x = this.data[base + i * 5];
      out[i].y = this.data[base + i * 5 + 1];
      out[i].z = this.data[base + i * 5 + 2];
      out[i].crouch = this.data[base + i * 5 + 3] !== 0;
      out[i].alive = this.data[base + i * 5 + 4] !== 0;
    }
    return bestTick;
  }
}
