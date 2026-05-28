// Hex-grid geometry tests (req §4.1). Locks in the odd-r offset coordinate
// system: 6-neighbor adjacency, cube-distance metric, and the pixel↔hex
// round-trip. Keeps the sim/render split honest by exercising hex.ts directly.

import { describe, expect, it } from "vitest";
import { HEX_SIZE } from "../src/config/index.js";
import {
  axialToOffset,
  hexDistance,
  hexNeighbors,
  hexStep,
  hexToPixel,
  HEX_HEIGHT,
  HEX_WIDTH,
  offsetToAxial,
  pixelToHex,
} from "../src/game/hex.js";

describe("hex neighbors (odd-r offset)", () => {
  it("an even-row hex has 6 neighbors and they're all hex-distance 1", () => {
    const ns = hexNeighbors(5, 4);
    expect(ns).toHaveLength(6);
    for (const n of ns) {
      expect(hexDistance({ x: 5, y: 4 }, n)).toBe(1);
    }
  });

  it("an odd-row hex has 6 neighbors at hex-distance 1", () => {
    const ns = hexNeighbors(5, 3);
    expect(ns).toHaveLength(6);
    for (const n of ns) {
      expect(hexDistance({ x: 5, y: 3 }, n)).toBe(1);
    }
  });

  it("neighbors of (5,4) and (5,3) overlap on shared edges", () => {
    // Two adjacent rows should be mutual neighbors of at least one shared hex.
    const evenNs = hexNeighbors(5, 4);
    const oddNs = hexNeighbors(5, 3);
    const inEven = (p: { x: number; y: number }) =>
      evenNs.some((q) => q.x === p.x && q.y === p.y);
    const inOdd = (p: { x: number; y: number }) =>
      oddNs.some((q) => q.x === p.x && q.y === p.y);
    expect(inOdd({ x: 5, y: 4 })).toBe(true);
    expect(inEven({ x: 5, y: 3 })).toBe(true);
  });
});

describe("hex distance", () => {
  it("self distance is 0", () => {
    expect(hexDistance({ x: 7, y: 7 }, { x: 7, y: 7 })).toBe(0);
  });

  it("straight east-west is just the column delta", () => {
    expect(hexDistance({ x: 2, y: 4 }, { x: 7, y: 4 })).toBe(5);
  });

  it("two rows down on the same column is 2", () => {
    expect(hexDistance({ x: 5, y: 4 }, { x: 5, y: 6 })).toBe(2);
  });

  it("triangle inequality holds for arbitrary triples", () => {
    const a = { x: 1, y: 2 };
    const b = { x: 7, y: 9 };
    const c = { x: 3, y: 5 };
    expect(hexDistance(a, c) + hexDistance(c, b)).toBeGreaterThanOrEqual(
      hexDistance(a, b),
    );
  });
});

describe("axial ↔ offset round-trip", () => {
  it("round-trips every hex in a 10×10 block", () => {
    for (let y = 0; y < 10; y++) {
      for (let x = 0; x < 10; x++) {
        const a = offsetToAxial({ x, y });
        const back = axialToOffset(a);
        expect(back).toEqual({ x, y });
      }
    }
  });
});

describe("pixel ↔ hex round-trip", () => {
  it("hexToPixel then pixelToHex returns the same hex", () => {
    // Check a sampling of even and odd rows.
    for (const [x, y] of [
      [0, 0],
      [5, 4],
      [5, 5],
      [9, 9],
      [12, 8],
      [3, 11],
    ] as const) {
      const { px, py } = hexToPixel(x, y);
      expect(pixelToHex(px, py)).toEqual({ x, y });
    }
  });

  it("pixels near a hex center map back to that hex", () => {
    const { px, py } = hexToPixel(5, 4);
    // Anywhere within the hex's incircle (apothem ≈ √3/2 · HEX_SIZE) maps back.
    const apothem = (Math.sqrt(3) / 2) * HEX_SIZE * 0.9; // 10% margin
    expect(pixelToHex(px + apothem, py)).toEqual({ x: 5, y: 4 });
    expect(pixelToHex(px, py + apothem)).toEqual({ x: 5, y: 4 });
  });

  it("HEX_WIDTH and HEX_HEIGHT follow the pointy-top formulas", () => {
    expect(HEX_WIDTH).toBeCloseTo(Math.sqrt(3) * HEX_SIZE, 6);
    expect(HEX_HEIGHT).toBe(2 * HEX_SIZE);
  });
});

describe("hexStep (cube-direction walk)", () => {
  it("walking N steps in direction d, then -d, returns to start", () => {
    const start = { x: 7, y: 6 };
    for (let d = 0; d < 6; d++) {
      const out = hexStep(start, d, 4);
      const back = hexStep(out, (d + 3) % 6, 4);
      expect(back).toEqual(start);
      expect(hexDistance(start, out)).toBe(4);
    }
  });
});
