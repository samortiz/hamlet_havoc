// A* on the hex grid (req §6.5). 6-directional with uniform cost 1 per hop —
// no diagonal-cost asymmetry, no corner-cutting check (neither exists on a
// hex grid). Deterministic: ties broken by insertion order so a given
// (map, start, goal) always yields the same path. Pure — depends only on the
// map's current walkability, which lets later milestones re-path when terrain
// or buildings change.

import { hexDistance, hexNeighbors } from "./hex.js";
import { isWalkable, type GameMap, type TileCoord } from "./map.js";

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

// Returns the tiles from the first step through the goal (excluding the start),
// [] if already at the goal, or null if the goal is unwalkable/unreachable.
export function findPath(
  map: GameMap,
  start: TileCoord,
  goal: TileCoord,
): TileCoord[] | null {
  if (!isWalkable(map, start.x, start.y) || !isWalkable(map, goal.x, goal.y))
    return null;
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
      if (!isWalkable(map, n.x, n.y)) continue;
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
