// Ink: freehand drawing on the paper. Strokes are geometry; this module gives them
// meaning — gesture classification, the strokes the AI draws for semantic shapes
// (circle this, arrow from A to B), and the drawn-boundary → neuron weights mapping.

import { mulberry32, round4, type Point } from './nn';

export type InkColor = 'ink' | 'orange' | 'blue' | 'violet';
export const INK_COLORS: InkColor[] = ['ink', 'orange', 'blue', 'violet'];
export const INK_HEX: Record<InkColor, string> = { ink: '#1f1f1d', orange: '#e0833f', blue: '#3c7fc2', violet: '#6b55c9' };
/** what a colour means when ink touches data: orange is class 1, blue is class 0 */
export const INK_LABEL: Partial<Record<InkColor, 0 | 1>> = { orange: 1, blue: 0 };

export type XY = [number, number];
export interface Stroke {
  points: XY[];
}

export type Gesture = 'dot' | 'line' | 'loop' | 'freeform';
export type AIShape = 'circle' | 'underline' | 'arrow' | 'cross' | 'check';
export const AI_SHAPES: AIShape[] = ['circle', 'underline', 'arrow', 'cross', 'check'];

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function strokeBBox(strokes: Stroke[]): Rect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of strokes)
    for (const [x, y] of s.points) {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  if (!Number.isFinite(x0)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function length(pts: XY[]): number {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return l;
}

/** Deterministic gesture recognition for a single stroke. */
export function classify(stroke: Stroke): Gesture {
  const p = stroke.points;
  if (p.length === 0) return 'dot';
  const bb = strokeBBox([stroke]);
  if (Math.hypot(bb.w, bb.h) < 14) return 'dot';
  const a = p[0];
  const b = p[p.length - 1];
  const chord = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const len = length(p);
  if (chord > 30) {
    // max distance of any point from the chord, relative to the chord
    const [dx, dy] = [(b[0] - a[0]) / chord, (b[1] - a[1]) / chord];
    let dev = 0;
    for (const q of p) dev = Math.max(dev, Math.abs((q[0] - a[0]) * dy - (q[1] - a[1]) * dx));
    if (dev < Math.max(8, chord * 0.08) && len < chord * 1.25) return 'line';
  }
  if (len > 120 && chord < Math.max(40, len * 0.2) && bb.w > 40 && bb.h > 40) return 'loop';
  return 'freeform';
}

/** Is a point inside a closed stroke (even-odd rule)? */
export function encloses(stroke: Stroke, [x, y]: XY): boolean {
  const p = stroke.points;
  let inside = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [xi, yi] = p[i];
    const [xj, yj] = p[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * The single-neuron weights whose decision boundary is the drawn line (in data
 * coordinates), oriented so the network classifies the data as well as possible.
 * Steepness is fixed so the boundary is crisp but still differentiable.
 */
export function boundaryWeights(from: XY, to: XY, data: Point[], steepness = 8): { w: [number, number]; b: number } | null {
  const [dx, dy] = [to[0] - from[0], to[1] - from[1]];
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return null;
  let n: XY = [-dy / len, dx / len]; // unit normal
  const side = (q: XY) => n[0] * (q[0] - from[0]) + n[1] * (q[1] - from[1]);
  // orientation: the side with more class-1 points is the positive side
  const score = data.reduce((s, p) => s + ((side(p.x) > 0 ? 1 : 0) === p.y ? 1 : -1), 0);
  if (score < 0) n = [-n[0], -n[1]];
  const w: [number, number] = [round4(n[0] * steepness), round4(n[1] * steepness)];
  const b = round4(-(w[0] * from[0] + w[1] * from[1]));
  return { w, b };
}

/** Hand-drawn strokes for a semantic shape around/between rectangles (the AI's pen). */
export function shapeStrokes(shape: AIShape, target: Rect, to: Rect | undefined, seed: number): Stroke[] {
  const rnd = mulberry32(seed);
  const jit = (s: number) => (rnd() - 0.5) * s;
  const cx = target.x + target.w / 2;
  const cy = target.y + target.h / 2;
  switch (shape) {
    case 'circle': {
      const rx = target.w / 2 + 18;
      const ry = target.h / 2 + 16;
      const start = rnd() * Math.PI * 2;
      const pts: XY[] = [];
      for (let i = 0; i <= 48; i++) {
        const t = start + (i / 44) * Math.PI * 2; // a little overshoot, like a real pen
        const wob = 1 + jit(0.05);
        pts.push([round1(cx + Math.cos(t) * rx * wob), round1(cy + Math.sin(t) * ry * wob)]);
      }
      return [{ points: pts }];
    }
    case 'underline': {
      const y = target.y + target.h + 10;
      const pts: XY[] = [];
      for (let i = 0; i <= 16; i++) pts.push([round1(target.x + 6 + (i / 16) * (target.w - 12)), round1(y + jit(3) + Math.sin(i / 3) * 1.5)]);
      return [{ points: pts }];
    }
    case 'cross': {
      const m = 10;
      return [
        { points: line([target.x + m, target.y + m], [target.x + target.w - m, target.y + target.h - m], jit) },
        { points: line([target.x + target.w - m, target.y + m], [target.x + m, target.y + target.h - m], jit) },
      ];
    }
    case 'check': {
      const s = Math.min(40, target.h * 0.5);
      const x = target.x + target.w + 10;
      const y = target.y + 8;
      return [{ points: [...line([x, y + s * 0.55], [x + s * 0.35, y + s], jit), ...line([x + s * 0.35, y + s], [x + s, y], jit)] }];
    }
    case 'arrow': {
      const dest = to ?? { x: target.x + target.w + 120, y: target.y, w: 0, h: target.h };
      const a = edgeToward(target, dest);
      const b = edgeToward(dest, target);
      const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
      const len = Math.hypot(dx, dy) || 1;
      const [ux, uy] = [dx / len, dy / len];
      // a gentle arc, then two head strokes
      const mid: XY = [(a[0] + b[0]) / 2 - uy * len * 0.12, (a[1] + b[1]) / 2 + ux * len * 0.12];
      const body: XY[] = [];
      for (let i = 0; i <= 20; i++) {
        const t = i / 20;
        const x = (1 - t) * (1 - t) * a[0] + 2 * (1 - t) * t * mid[0] + t * t * b[0];
        const y = (1 - t) * (1 - t) * a[1] + 2 * (1 - t) * t * mid[1] + t * t * b[1];
        body.push([round1(x + jit(1.5)), round1(y + jit(1.5))]);
      }
      const tip = body[body.length - 1];
      const prev = body[body.length - 3];
      const ang = Math.atan2(tip[1] - prev[1], tip[0] - prev[0]);
      const head = (d: number): XY => [round1(tip[0] - Math.cos(ang + d) * 14), round1(tip[1] - Math.sin(ang + d) * 14)];
      return [{ points: body }, { points: [head(0.45), tip, head(-0.45)] }];
    }
  }
}

function line(a: XY, b: XY, jit: (s: number) => number): XY[] {
  const pts: XY[] = [];
  for (let i = 0; i <= 10; i++) pts.push([round1(a[0] + ((b[0] - a[0]) * i) / 10 + jit(2)), round1(a[1] + ((b[1] - a[1]) * i) / 10 + jit(2))]);
  return pts;
}

function edgeToward(r: Rect, other: Rect): XY {
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  const ox = other.x + other.w / 2, oy = other.y + other.h / 2;
  const [dx, dy] = [ox - cx, oy - cy];
  const t = Math.min(Math.abs((r.w / 2 + 8) / (dx || 1e-9)), Math.abs((r.h / 2 + 8) / (dy || 1e-9)));
  return [round1(cx + dx * t), round1(cy + dy * t)];
}

const round1 = (x: number) => Math.round(x * 10) / 10;
