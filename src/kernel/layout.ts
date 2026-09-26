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
    .filter((o) => !o.visual.hidden && o.kind !== 'group' && !(ignore && ignore.has(o.id)))
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

  const anchorId =
    placement &&
    ((placement as any).beside ?? (placement as any).below ?? (placement as any).above ?? (placement as any).left_of ?? (placement as any).near);
  const anchor: TSObject | undefined = anchorId ? ws.objects[anchorId] : undefined;
  const a: Rect | undefined = anchor
    ? anchor.visual
    : pending.length
      ? pending[pending.length - 1]
      : undefined;

  if (!a) {
    // first free slot scanning rows from the origin
    for (let row = 0; row < 40; row++)
      for (let col = 0; col < 8; col++) {
        const r = { x: 80 + col * 60, y: 80 + row * 60, w, h };
        if (free(r, taken)) return r;
      }
    return { x: 80, y: 80, w, h };
  }

  const dir: 'right' | 'below' | 'above' | 'left' =
    placement && 'below' in placement ? 'below' : placement && 'above' in placement ? 'above' : placement && 'left_of' in placement ? 'left' : 'right';

  const step = 24;
  for (let k = 0; k < 60; k++) {
    let r: Rect;
    switch (dir) {
      case 'right':
        r = { x: a.x + a.w + GAP + (k >= 20 ? (k - 20) * step : 0), y: a.y + (k < 20 ? k * step : 0), w, h };
        break;
      case 'left':
        r = { x: a.x - w - GAP - (k >= 20 ? (k - 20) * step : 0), y: a.y + (k < 20 ? k * step : 0), w, h };
        break;
      case 'below':
        r = { x: a.x + (k < 20 ? k * step : 0), y: a.y + a.h + GAP + (k >= 20 ? (k - 20) * step : 0), w, h };
        break;
      case 'above':
        r = { x: a.x + (k < 20 ? k * step : 0), y: a.y - h - GAP - (k >= 20 ? (k - 20) * step : 0), w, h };
        break;
    }
    if (free(r, taken)) return r;
  }
  return { x: a.x + a.w + GAP, y: a.y, w, h };
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

/** Nearest free position for a block, scanning downward then rightward from its preferred spot. */
export function findFree(ws: Workspace, block: Rect, ignore: Set<ObjectId>): { x: number; y: number } {
  const taken = occupied(ws, [], ignore);
  for (let col = 0; col < 12; col++)
    for (let row = 0; row < 16; row++) {
      const r = { ...block, x: block.x + col * 60, y: block.y + row * 40 };
      if (free(r, taken)) return r;
    }
  return block;
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
