// The pen. Ink is drawn on the paper and, where it lands on something that understands
// it, becomes meaning: a dot of coloured ink on a plot is a data point, a line across a
// single neuron's plot is its decision boundary, a loop around objects selects them.
// Everything else stays ink — a persistent sketch object attached to what it was drawn on.

import { useEffect, useRef, useState } from 'react';
import { datasetFor, ink, nn, points, sourceOf, type TSObject, type Workspace } from '../kernel';
import { useUI, type UI } from './context';
import type { View } from './Canvas';

type Pt = { wx: number; wy: number; sx: number; sy: number };

/** smooth SVG path through points (quadratic segments via midpoints) */
export function smoothPath(pts: [number, number][]): string {
  if (pts.length === 0) return '';
  if (pts.length === 1) return `M${pts[0][0]},${pts[0][1]} l0.1,0`;
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [x, y] = pts[i];
    const [nx, ny] = pts[i + 1];
    d += ` Q${x},${y} ${(x + nx) / 2},${(y + ny) / 2}`;
  }
  const last = pts[pts.length - 1];
  return `${d} L${last[0]},${last[1]}`;
}

// ------------------------------------------------------------------ rendering ink

export function SketchLayer({ ws, onDown }: { ws: Workspace; onDown: (e: React.PointerEvent, o: TSObject) => void }) {
  const ui = useUI();
  const sketches = Object.values(ws.objects).filter((o) => o.kind === 'sketch' && !o.visual.hidden);
  return (
    <>
      {sketches.map((o) => {
        const selected = ui.selection.includes(o.id);
        const colour = ink.INK_HEX[o.state.color as ink.InkColor] ?? ink.INK_HEX.ink;
        return (
          <svg
            key={o.id}
            className={`sketch ${selected ? 'selected' : ''} ${ui.isHighlighted(o.id) ? 'hi' : ''}`}
            style={{ left: o.visual.x, top: o.visual.y, width: o.visual.w, height: o.visual.h }}
            width={o.visual.w}
            height={o.visual.h}
          >
            <title>{`${o.provenance.createdBy === 'ai' ? 'drawn by the AI' : 'your ink'}${o.state.note ? ` — ${o.state.note}` : ''}`}</title>
            {selected && <rect x={1} y={1} width={o.visual.w - 2} height={o.visual.h - 2} className="sketch-sel" />}
            {(o.state.strokes as ink.Stroke[]).map((s, i) => (
              <g key={i} onPointerDown={(e) => onDown(e, o)}>
                <path className="sketch-hit" d={smoothPath(s.points)} />
                <path d={smoothPath(s.points)} stroke={colour} strokeWidth={o.provenance.createdBy === 'ai' ? 2.4 : 2.6} fill="none" strokeLinecap="round" strokeLinejoin="round" opacity={0.92} />
              </g>
            ))}
          </svg>
        );
      })}
    </>
  );
}

// ------------------------------------------------------------------ the pen

export function PenOverlay({ view, toWorld }: { view: View; toWorld: (cx: number, cy: number) => { x: number; y: number } }) {
  const ui = useUI();
  const [strokes, setStrokes] = useState<Pt[][]>([]);
  const current = useRef<Pt[] | null>(null);
  const pending = useRef<Pt[][]>([]);
  const timer = useRef<number | undefined>(undefined);
  const [, force] = useState(0);

  // multi-stroke drawings (letters, arrows) commit together after a short pause
  const commitSoon = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const batch = pending.current;
      pending.current = [];
      setStrokes([]);
      if (batch.length) interpret(batch, ui);
    }, 650);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const pt = (e: React.PointerEvent): Pt => {
    const w = toWorld(e.clientX, e.clientY);
    return { wx: w.x, wy: w.y, sx: e.clientX, sy: e.clientY };
  };

  return (
    <div
      className="pen-overlay"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        (e.target as Element).setPointerCapture(e.pointerId);
        window.clearTimeout(timer.current);
        current.current = [pt(e)];
        force((n) => n + 1);
      }}
      onPointerMove={(e) => {
        const c = current.current;
        if (!c) return;
        const p = pt(e);
        const last = c[c.length - 1];
        if (Math.hypot(p.sx - last.sx, p.sy - last.sy) < 2) return;
        c.push(p);
        force((n) => n + 1);
      }}
      onPointerUp={() => {
        const c = current.current;
        current.current = null;
        if (!c) return;
        pending.current = [...pending.current, c];
        setStrokes(pending.current);
        commitSoon();
      }}
      onWheel={(e) => e.stopPropagation()}
    >
      <svg className="pen-live">
        <g transform={`translate(${view.x},${view.y}) scale(${view.s})`}>
          {[...strokes, ...(current.current ? [current.current] : [])].map((s, i) => (
            <path key={i} d={smoothPath(s.map((p) => [p.wx, p.wy]))} stroke={ink.INK_HEX[ui.pen]} strokeWidth={2.6} fill="none" strokeLinecap="round" strokeLinejoin="round" />
          ))}
        </g>
      </svg>
    </div>
  );
}

// ------------------------------------------------------------------ meaning

interface PlotHit {
  obj: TSObject;
  el: Element;
}

/** what rendered plot (and object) is under a screen point — the renderer owns geometry */
function plotAt(sx: number, sy: number, ws: Workspace): PlotHit | undefined {
  for (const el of document.elementsFromPoint(sx, sy)) {
    const plot = el.closest('.plot');
    const host = el.closest('[data-obj]') as HTMLElement | null;
    if (plot && host) {
      const obj = ws.objects[host.dataset.obj!];
      if (obj) return { obj, el: plot };
    }
  }
}

function objectAt(sx: number, sy: number, ws: Workspace): TSObject | undefined {
  for (const el of document.elementsFromPoint(sx, sy)) {
    const host = el.closest('[data-obj]') as HTMLElement | null;
    const o = host && ws.objects[host.dataset.obj!];
    if (o && o.kind !== 'sketch' && o.kind !== 'group') return o;
  }
}

/** screen point → data coordinates of the dataset a plot shows */
function toData(hit: PlotHit, ws: Workspace, sx: number, sy: number): { data: TSObject; x: [number, number] } | undefined {
  const data = hit.obj.kind === 'dataset' ? hit.obj : hit.obj.kind === 'graph' ? (() => {
    const src = sourceOf(ws, hit.obj.id);
    return src?.kind === 'neural_network' ? datasetFor(ws, src.id) : undefined;
  })() : undefined;
  if (!data) return;
  const dom = nn.domainFor(points(data));
  const r = hit.el.getBoundingClientRect();
  const x1 = dom.x0 + ((sx - r.left) / r.width) * (dom.x1 - dom.x0);
  const x2 = dom.y1 - ((sy - r.top) / r.height) * (dom.y1 - dom.y0);
  return { data, x: [Math.round(x1 * 100) / 100, Math.round(x2 * 100) / 100] };
}

function interpret(batch: Pt[][], ui: UI) {
  const ws = ui.ws;
  const world = batch.map((s) => ({ points: s.map((p) => [p.wx, p.wy] as [number, number]) }));
  const colour = ui.pen;

  if (batch.length === 1) {
    const s = batch[0];
    const gesture = ink.classify(world[0]);
    const a = s[0];
    const b = s[s.length - 1];

    // a dot of coloured ink on data is a new data point
    if (gesture === 'dot' && ink.INK_LABEL[colour] !== undefined) {
      const hit = plotAt(a.sx, a.sy, ws);
      const d = hit && toData(hit, ws, a.sx, a.sy);
      if (d) {
        ui.act([{ op: 'invoke', id: d.data.id, action: 'add_point', args: { x1: d.x[0], x2: d.x[1], label: ink.INK_LABEL[colour] } }], { summary: `ink: point (${d.x.join(', ')}) = ${ink.INK_LABEL[colour]}` });
        return;
      }
    }

    // a straight line across a network's boundary plot is the boundary you want
    if (gesture === 'line') {
      const ha = plotAt(a.sx, a.sy, ws);
      const hb = plotAt(b.sx, b.sy, ws);
      if (ha && hb && ha.obj.id === hb.obj.id && ha.obj.kind === 'graph' && ha.obj.params.mode === 'decision_boundary') {
        const da = toData(ha, ws, a.sx, a.sy);
        const db = toData(hb, ws, b.sx, b.sy);
        if (da && db) {
          const r = ui.act([{ op: 'set_boundary', id: ha.obj.id, from: da.x, to: db.x }], { summary: 'ink: drawn boundary' });
          if (r.ok) return;
          // the network can't take a straight boundary; keep the ink so the thought isn't lost
        }
      }
    }

    // a loop around objects selects them — "this" becomes what you circled
    if (gesture === 'loop') {
      const inside = Object.values(ws.objects)
        .filter((o) => !o.visual.hidden && o.kind !== 'sketch' && o.kind !== 'group')
        .filter((o) => ink.encloses(world[0], [o.visual.x + o.visual.w / 2, o.visual.y + o.visual.h / 2]))
        .map((o) => o.id);
      if (inside.length) {
        ui.select(inside);
        return;
      }
    }
  }

  // otherwise it stays ink, attached to whatever it was drawn on
  const all = batch.flat();
  const cx = all.reduce((t, p) => t + p.sx, 0) / all.length;
  const cy = all.reduce((t, p) => t + p.sy, 0) / all.length;
  const over = objectAt(cx, cy, ws) ?? objectAt(all[0].sx, all[0].sy, ws);
  ui.act([{ op: 'draw', strokes: world, color: colour, ...(over ? { over: over.id } : {}) }], { summary: 'ink' });
}

export const INK_SWATCHES: { color: ink.InkColor; title: string }[] = [
  { color: 'ink', title: 'ink' },
  { color: 'orange', title: 'orange — a dot on data adds a class-1 point' },
  { color: 'blue', title: 'blue — a dot on data adds a class-0 point' },
  { color: 'violet', title: 'violet' },
];

