// A* on the walkable tile grid (req §6.5). 8-directional with no diagonal
// corner-cutting. Deterministic: ties broken by insertion order so a given
// (map, start, goal) always yields the same path. Pure — depends only on the
// map's current walkability, which lets later milestones re-path when terrain
// or buildings change.

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

const SQRT2 = Math.SQRT2;
const DIRS: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, SQRT2],
  [1, -1, SQRT2],
  [-1, 1, SQRT2],
  [-1, -1, SQRT2],
];

function octile(ax: number, ay: number, bx: number, by: number): number {
  const dx = Math.abs(ax - bx);
  const dy = Math.abs(ay - by);
  return dx + dy + (SQRT2 - 2) * Math.min(dx, dy);
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
  open.push({ idx: startIdx, f: octile(start.x, start.y, goal.x, goal.y), seq: seq++ });

  while (open.size > 0) {
    const cur = open.pop();
    if (closed.has(cur.idx)) continue;
    if (cur.idx === goalIdx) break;
    closed.add(cur.idx);
    const cx = cur.idx % W;
    const cy = (cur.idx - cx) / W;
    const cg = g.get(cur.idx) as number;

    for (const [dx, dy, cost] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!isWalkable(map, nx, ny)) continue;
      if (dx !== 0 && dy !== 0) {
        // disallow squeezing diagonally between two blocked tiles
        if (!isWalkable(map, cx + dx, cy) || !isWalkable(map, cx, cy + dy)) continue;
      }
      const nIdx = ny * W + nx;
      if (closed.has(nIdx)) continue;
      const ng = cg + cost;
      if (ng < (g.get(nIdx) ?? Infinity)) {
        g.set(nIdx, ng);
        cameFrom.set(nIdx, cur.idx);
        open.push({ idx: nIdx, f: ng + octile(nx, ny, goal.x, goal.y), seq: seq++ });
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
