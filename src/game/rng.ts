// Seeded PRNG (mulberry32). The generator state is a plain number stored in
// GameState (req §2.6), so the whole simulation is deterministic and the RNG
// survives JSON save/load. The simulation must never call Math.random().

// Advance the generator. Returns the next state and a float in [0, 1).
export function rngNext(state: number): [nextState: number, value: number] {
  let a = state | 0;
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return [a >>> 0, value];
}

// Integer in [min, max] inclusive.
export function rngInt(
  state: number,
  min: number,
  max: number,
): [nextState: number, value: number] {
  const [next, value] = rngNext(state);
  return [next, min + Math.floor(value * (max - min + 1))];
}
