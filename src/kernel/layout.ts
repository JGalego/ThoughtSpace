// Semantic placement → coordinates. Clients say "beside net_1"; the layout engine decides where.

import type { ObjectId, SemanticPlacement, TSObject, VisualState, Workspace } from './types';

const GAP = 36;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function overlaps(a: Rect, b: Rect, margin = 16): boolean {
  return a.x < b.x + b.w + margin && a.x + a.w + margin > b.x && a.y < b.y + b.h + margin && a.y + a.h + margin > b.y;
}

function occupied(ws: Workspace, pending: Rect[], ignore?: Set<ObjectId>): Rect[] {
  const rs: Rect[] = Object.values(ws.objects)
    .filter((o) => !o.visual.hidden && o.kind !== 'group' && o.kind !== 'sketch' && !(ignore && ignore.has(o.id)))  // ink is on the paper, not in the way
    .map((o) => o.visual);
  return rs.concat(pending);
}

function free(r: Rect, taken: Rect[]): boolean {
  return !taken.some((t) => overlaps(r, t));
}

/**
 * Find a free spot for a w×h object according to a semantic placement.
 * `pending` are rects allocated earlier in the same transaction.
 */
export function place(
  ws: Workspace,
  size: { w: number; h: number },
  placement: SemanticPlacement | undefined,
  pending: Rect[] = [],
): VisualState {
  const taken = occupied(ws, pending);
  const { w, h } = size;

  if (placement && 'at' in placement) return { x: placement.at.x, y: placement.at.y, w, h };
  if (placement && 'around' in placement) return nearestFree({ x: placement.around.x - w / 2, y: placement.around.y - h / 2, w, h }, taken, 'below');

  const anchorId =
    placement &&
    ((placement as any).beside ?? (placement as any).below ?? (placement as any).above ?? (placement as any).left_of ?? (placement as any).near);
  const anchor: TSObject | undefined = anchorId ? ws.objects[anchorId] : undefined;
  const a: Rect | undefined = anchor
    ? anchor.visual
    : pending.length
      ? pending[pending.length - 1]
      : undefined;

  if (!a) return nearestFree({ x: 80, y: 80, w, h }, taken, 'below');

  const dir: 'right' | 'below' | 'above' | 'left' =
    placement && 'below' in placement ? 'below' : placement && 'above' in placement ? 'above' : placement && 'left_of' in placement ? 'left' : 'right';
  const ideal: Rect =
    dir === 'right' ? { x: a.x + a.w + GAP, y: a.y, w, h }
    : dir === 'left' ? { x: a.x - w - GAP, y: a.y, w, h }
    : dir === 'below' ? { x: a.x, y: a.y + a.h + GAP, w, h }
    : { x: a.x, y: a.y - h - GAP, w, h };
  return nearestFree(ideal, taken, dir);
}

/**
 * The free position closest to the ideal one. Searches square rings of growing radius
 * on a 24px grid, so it always terminates with a non-overlapping spot; moving along the
 * requested direction is slightly cheaper than moving against it.
 */
export function nearestFree(ideal: Rect, taken: Rect[], dir: 'right' | 'below' | 'above' | 'left'): VisualState {
  const step = 24;
  if (free(ideal, taken)) return { ...ideal };
  const along = { right: [1, 0], left: [-1, 0], below: [0, 1], above: [0, -1] }[dir];
  for (let ring = 1; ring < 400; ring++) {
    let best: Rect | undefined;
    let bestCost = Infinity;
    for (let i = -ring; i <= ring; i++)
      for (const [dx, dy] of [[i, -ring], [i, ring], [-ring, i], [ring, i]]) {
        const r = { ...ideal, x: ideal.x + dx * step, y: ideal.y + dy * step };
        const backwards = Math.max(0, -(dx * along[0] + dy * along[1]));
        const cost = Math.hypot(dx, dy) + backwards * 0.6;
        if (cost < bestCost && free(r, taken)) {
          best = r;
          bestCost = cost;
        }
      }
    if (best) return best;
  }
  return { ...ideal };
}

/**
 * Tidy relative layout for a construction: keep reading order (top-to-bottom, then
 * left-to-right) and flow objects into rows no wider than maxW.
 */
export function pack(objs: { id: ObjectId; visual: Rect }[], maxW = 1000, gap = 36): Record<ObjectId, { x: number; y: number }> {
  const order = [...objs].sort((a, b) => a.visual.y - b.visual.y || a.visual.x - b.visual.x);
  const out: Record<ObjectId, { x: number; y: number }> = {};
  let x = 0, y = 0, rowH = 0;
  for (const o of order) {
    if (x > 0 && x + o.visual.w > maxW) {
      x = 0;
      y += rowH + gap;
      rowH = 0;
    }
    out[o.id] = { x, y };
    x += o.visual.w + gap;
    rowH = Math.max(rowH, o.visual.h);
  }
  return out;
}

export function bbox(objs: { visual: Rect }[]): Rect {
  if (objs.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const o of objs) {
    x0 = Math.min(x0, o.visual.x);
    y0 = Math.min(y0, o.visual.y);
    x1 = Math.max(x1, o.visual.x + o.visual.w);
    y1 = Math.max(y1, o.visual.y + o.visual.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Nearest free position for a block near its preferred spot, ignoring some objects. */
export function findFree(ws: Workspace, block: Rect, ignore: Set<ObjectId>): { x: number; y: number } {
  return nearestFree(block, occupied(ws, [], ignore), 'below');
}

/** Place a set of objects (a sub-graph) as a block to the right of / below its original. */
export function placeBlock(
  ws: Workspace,
  block: Rect,
  prefer: 'right' | 'below',
  pending: Rect[] = [],
  ignore?: Set<ObjectId>,
): { dx: number; dy: number } {
  const taken = occupied(ws, pending, ignore);
  for (let k = 0; k < 80; k++) {
    const dx = prefer === 'right' ? block.w + GAP * 2 + k * 40 : 0;
    const dy = prefer === 'below' ? block.h + GAP * 2 + k * 40 : 0;
    const r = { x: block.x + dx, y: block.y + dy, w: block.w, h: block.h };
    if (free(r, taken)) return { dx, dy };
  }
  return { dx: block.w + GAP * 2, dy: 0 };
}
