// A* on the hex grid (req §6.5). 6-directional with uniform cost 1 per hop —
// no diagonal-cost asymmetry, no corner-cutting check (neither exists on a
// hex grid). Deterministic: ties broken by insertion order so a given
// (map, start, goal) always yields the same path. Pure — depends only on the
// map's current walkability, which lets callers re-path when terrain
// or buildings change.

import type { Building } from "./buildings.js";
import { hexDistance, hexNeighbors } from "./hex.js";
import { inBounds, isWalkable, tileAt, type GameMap, type TileCoord } from "./map.js";

interface HeapItem {
  idx: number;
  f: number;
  seq: number;
}

function less(a: HeapItem, b: HeapItem): boolean {
  return a.f < b.f || (a.f === b.f && a.seq < b.seq);
}

class MinHeap {
  private items: HeapItem[] = [];
  get size(): number {
    return this.items.length;
  }
  push(item: HeapItem): void {
    const a = this.items;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (less(a[i], a[p])) {
        [a[i], a[p]] = [a[p], a[i]];
        i = p;
      } else break;
    }
  }
  pop(): HeapItem {
    const a = this.items;
    const top = a[0];
    const last = a.pop() as HeapItem;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = 2 * i + 2;
        let s = i;
        if (l < a.length && less(a[l], a[s])) s = l;
        if (r < a.length && less(a[r], a[s])) s = r;
        if (s === i) break;
        [a[i], a[s]] = [a[s], a[i]];
        i = s;
      }
    }
    return top;
  }
}

// Core A* parameterised by a `passable(x, y)` predicate, so the same search
// drives both land movement (walkable tiles) and water-predator movement
// (water-only tiles). Returns the tiles from the first step through the goal
// (excluding the start), [] if already at the goal, or null if the goal is
// impassable/unreachable.
function aStar(
  map: GameMap,
  start: TileCoord,
  goal: TileCoord,
  passable: (x: number, y: number) => boolean,
): TileCoord[] | null {
  // The goal must be reachable, but the start need not be passable — a unit can
  // always step off the tile it stands on (e.g. a mountain whose Mine was just
  // demolished), so we only gate on the goal here and on neighbours below.
  if (!passable(goal.x, goal.y)) return null;
  if (start.x === goal.x && start.y === goal.y) return [];

  const W = map.width;
  const startIdx = start.y * W + start.x;
  const goalIdx = goal.y * W + goal.x;

  const g = new Map<number, number>();
  const cameFrom = new Map<number, number>();
  const closed = new Set<number>();
  const open = new MinHeap();
  let seq = 0;

  g.set(startIdx, 0);
  open.push({ idx: startIdx, f: hexDistance(start, goal), seq: seq++ });

  while (open.size > 0) {
    const cur = open.pop();
    if (closed.has(cur.idx)) continue;
    if (cur.idx === goalIdx) break;
    closed.add(cur.idx);
    const cx = cur.idx % W;
    const cy = (cur.idx - cx) / W;
    const cg = g.get(cur.idx) as number;

    for (const n of hexNeighbors(cx, cy)) {
      if (!passable(n.x, n.y)) continue;
      const nIdx = n.y * W + n.x;
      if (closed.has(nIdx)) continue;
      const ng = cg + 1; // uniform cost on a hex grid
      if (ng < (g.get(nIdx) ?? Infinity)) {
        g.set(nIdx, ng);
        cameFrom.set(nIdx, cur.idx);
        open.push({ idx: nIdx, f: ng + hexDistance(n, goal), seq: seq++ });
      }
    }
  }

  if (!g.has(goalIdx)) return null;

  const path: TileCoord[] = [];
  let cur = goalIdx;
  while (cur !== startIdx) {
    const x = cur % W;
    const y = (cur - x) / W;
    path.push({ x, y });
    const prev = cameFrom.get(cur);
    if (prev === undefined) return null;
    cur = prev;
  }
  path.reverse();
  return path;
}

// Land movement: A* over walkable tiles (req §6.5). Walkability depends on the
// current buildings (a built Mine opens its mountain), so callers pass them.
export function findPath(
  map: GameMap,
  start: TileCoord,
  goal: TileCoord,
  buildings?: Record<number, Building>,
): TileCoord[] | null {
  return aStar(map, start, goal, (x, y) => isWalkable(map, x, y, buildings));
}

// Water-predator movement: A* restricted to water tiles (req §14). Sea serpents
// and krakens hunt within the water and never step onto land, so the only
// passable tiles are water.
export function findWaterPath(
  map: GameMap,
  start: TileCoord,
  goal: TileCoord,
): TileCoord[] | null {
  return aStar(map, start, goal, (x, y) => inBounds(map, x, y) && tileAt(map, x, y) === "water");
}
