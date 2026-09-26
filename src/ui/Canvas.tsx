// The infinite canvas: pan, zoom (which drives semantic zoom), select, drag, resize, connect.

import { useRef, useState, type JSX } from 'react';
import { kindSpec, suggestions, type ObjectId, type Relation, type TSObject, type Workspace } from '../kernel';
import { useUI } from './context';
import { RENDERERS } from './views';

export interface View {
  x: number;
  y: number;
  s: number;
}

type Drag =
  | { kind: 'pan'; x0: number; y0: number; v: View; moved: boolean }
  | { kind: 'marquee'; x0: number; y0: number; x1: number; y1: number }
  | { kind: 'move'; x0: number; y0: number; starts: Record<string, { x: number; y: number }>; key: string }
  | { kind: 'resize'; id: string; x0: number; y0: number; w0: number; h0: number }
  | { kind: 'connect'; from: string; x: number; y: number };

export function Canvas({ view, setView }: { view: View; setView: (v: View) => void }) {
  const ui = useUI();
  const { ws } = ui;
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const set = (d: Drag | null) => {
    dragRef.current = d;
    setDrag(d);
  };

  const toWorld = (cx: number, cy: number) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: (cx - r.left - view.x) / view.s, y: (cy - r.top - view.y) / view.s };
  };

  const visible = Object.values(ws.objects).filter((o) => !o.visual.hidden);
  const groups = visible.filter((o) => o.kind === 'group');
  const others = visible.filter((o) => o.kind !== 'group');
  const sugg = suggestions(ws).filter((s) => !ui.dismissed.has(s.key));

  // ------------------------------------------------------------ pointer handling

  const onBgDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    if (e.shiftKey) {
      const p = toWorld(e.clientX, e.clientY);
      set({ kind: 'marquee', x0: p.x, y0: p.y, x1: p.x, y1: p.y });
    } else set({ kind: 'pan', x0: e.clientX, y0: e.clientY, v: view, moved: false });
  };

  const onMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    if (d.kind === 'pan') {
      const dx = e.clientX - d.x0, dy = e.clientY - d.y0;
      if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
      setView({ ...d.v, x: d.v.x + dx, y: d.v.y + dy });
    } else if (d.kind === 'marquee') {
      const p = toWorld(e.clientX, e.clientY);
      set({ ...d, x1: p.x, y1: p.y });
    } else if (d.kind === 'move') {
      const dx = (e.clientX - d.x0) / view.s, dy = (e.clientY - d.y0) / view.s;
      ui.act(
        Object.entries(d.starts).map(([id, s]) => ({ op: 'move_object', id, placement: { at: { x: Math.round(s.x + dx), y: Math.round(s.y + dy) } } })),
        { coalesceKey: d.key, summary: 'move' },
      );
    } else if (d.kind === 'resize') {
      const w = d.w0 + (e.clientX - d.x0) / view.s, h = d.h0 + (e.clientY - d.y0) / view.s;
      ui.act([{ op: 'resize_object', id: d.id, size: { w: Math.round(w), h: Math.round(h) } }], { coalesceKey: `resize:${d.id}:${d.w0}`, summary: 'resize' });
    } else if (d.kind === 'connect') {
      const p = toWorld(e.clientX, e.clientY);
      set({ ...d, x: p.x, y: p.y });
    }
  };

  const onUp = (e: React.PointerEvent) => {
    const d = dragRef.current;
    set(null);
    if (!d) return;
    if (d.kind === 'pan' && !d.moved) ui.select([]);
    if (d.kind === 'marquee') {
      const x0 = Math.min(d.x0, d.x1), x1 = Math.max(d.x0, d.x1), y0 = Math.min(d.y0, d.y1), y1 = Math.max(d.y0, d.y1);
      const hit = others.filter((o) => o.visual.x < x1 && o.visual.x + o.visual.w > x0 && o.visual.y < y1 && o.visual.y + o.visual.h > y0).map((o) => o.id);
      ui.select(hit, e.shiftKey);
    }
    if (d.kind === 'connect') {
      const el = document.elementsFromPoint(e.clientX, e.clientY).find((x) => (x as HTMLElement).dataset?.obj && (x as HTMLElement).dataset.obj !== d.from) as HTMLElement | undefined;
      if (el) connect(ws, d.from, el.dataset.obj!, ui);
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      const r = ref.current!.getBoundingClientRect();
      const s = Math.max(0.25, Math.min(2.5, view.s * Math.exp(-e.deltaY * 0.01)));
      const cx = e.clientX - r.left, cy = e.clientY - r.top;
      setView({ s, x: cx - ((cx - view.x) * s) / view.s, y: cy - ((cy - view.y) * s) / view.s });
    } else setView({ ...view, x: view.x - e.deltaX, y: view.y - e.deltaY });
  };

  const startMove = (e: React.PointerEvent, o: TSObject) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    let sel = ui.selection;
    if (!sel.includes(o.id)) {
      sel = e.shiftKey ? [...sel, o.id] : [o.id];
      ui.select(sel);
    } else if (e.shiftKey) {
      ui.select(sel.filter((x) => x !== o.id));
      return;
    }
    const starts: Record<string, { x: number; y: number }> = {};
    for (const id of sel) {
      const s = ws.objects[id];
      if (s && !s.visual.hidden) starts[id] = { x: s.visual.x, y: s.visual.y };
    }
    set({ kind: 'move', x0: e.clientX, y0: e.clientY, starts, key: `move:${Date.now()}` });
  };

  // --------------------------------------------------------------------- render

  return (
    <div ref={ref} className={`canvas ${drag?.kind === 'pan' ? 'panning' : ''}`} onPointerDown={onBgDown} onPointerMove={onMove} onPointerUp={onUp} onWheel={onWheel}>
      <div className="canvas-bg" style={{ backgroundSize: `${22 * view.s}px ${22 * view.s}px`, backgroundPosition: `${view.x}px ${view.y}px` }} />
      <div className="world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})` }}>
        <Relations ws={ws} pending={drag?.kind === 'connect' ? drag : null} />
        {Object.values(ws.objects)
          .filter((g) => g.kind === 'glyph' && g.visual.expanded && !g.visual.hidden)
          .map((g) => <GlyphFrame key={`f${g.id}`} g={g} ws={ws} />)}
        {groups.map((o) => (
          <Frame key={o.id} o={o} onHeadDown={startMove} onResize={() => {}} onPort={() => {}} suggestions={[]} />
        ))}
        {others.map((o) => (
          <Frame
            key={o.id}
            o={o}
            onHeadDown={startMove}
            onResize={(e) => {
              e.stopPropagation();
              (e.target as Element).setPointerCapture?.(e.pointerId);
              set({ kind: 'resize', id: o.id, x0: e.clientX, y0: e.clientY, w0: o.visual.w, h0: o.visual.h });
            }}
            onPort={(e) => {
              e.stopPropagation();
              (e.target as Element).setPointerCapture?.(e.pointerId);
              const p = toWorld(e.clientX, e.clientY);
              set({ kind: 'connect', from: o.id, x: p.x, y: p.y });
            }}
            suggestions={sugg.filter((s) => s.target === o.id).slice(0, 1)}
          />
        ))}
        {drag?.kind === 'marquee' && (
          <div className="marquee" style={{ left: Math.min(drag.x0, drag.x1), top: Math.min(drag.y0, drag.y1), width: Math.abs(drag.x1 - drag.x0), height: Math.abs(drag.y1 - drag.y0) }} />
        )}
      </div>
    </div>
  );
}

function connect(ws: Workspace, from: ObjectId, to: ObjectId, ui: ReturnType<typeof useUI>) {
  const a = ws.objects[from];
  const b = ws.objects[to];
  if (!a || !b) return;
  const target = b.kind === 'glyph' ? ws.objects[b.state.output] ?? b : b;
  if (a.kind === 'dataset' && target.kind === 'neural_network') ui.act([{ op: 'connect', from, to: target.id, relation: 'feeds_into' }]);
  else if ((a.kind === 'neural_network' || a.kind === 'glyph') && (b.kind === 'graph' || b.kind === 'equation')) ui.act([{ op: 'connect', from: to, to: from, relation: 'visualizes' }]);
  else if (a.kind === 'neural_network' && b.kind === 'neural_network') ui.act([{ op: 'compare', a: from, b: to }]);
  else ui.act([{ op: 'connect', from, to, relation: 'derived_from' }]);
}

// ------------------------------------------------------------------ frame

function Frame({
  o,
  onHeadDown,
  onResize,
  onPort,
  suggestions: sugg,
}: {
  o: TSObject;
  onHeadDown: (e: React.PointerEvent, o: TSObject) => void;
  onResize: (e: React.PointerEvent) => void;
  onPort: (e: React.PointerEvent) => void;
  suggestions: ReturnType<typeof suggestions>;
}) {
  const ui = useUI();
  const [renaming, setRenaming] = useState(false);
  const selected = ui.selection.includes(o.id);
  const spec = kindSpec(o.kind)!;
  const ports = spec.ports(o);
  const R = RENDERERS[o.kind];
  const glance = ui.detail === 'glance' && R.glance;
  const variant = !!o.provenance.assumption;
  const cls = [
    'obj',
    `kind-${o.kind}`,
    selected ? 'selected' : '',
    ui.isHighlighted(o.id) ? 'hi' : '',
    variant ? 'variant' : '',
    o.kind === 'claim' ? o.state.status : '',
  ].join(' ');
  const mark = o.provenance.createdBy === 'ai' ? '✦' : o.provenance.createdBy === 'human' ? '●' : '·';

  return (
    <div
      className={cls}
      data-obj={o.id}
      style={{ left: o.visual.x, top: o.visual.y, width: o.visual.w, height: o.visual.h, zIndex: o.kind === 'group' ? 0 : selected ? 3 : 1 }}
      onPointerDown={(e) => {
        e.stopPropagation();
        if (!ui.selection.includes(o.id)) ui.select([o.id], e.shiftKey);
      }}
    >
      <div className="obj-head" onPointerDown={(e) => onHeadDown(e, o)} onDoubleClick={() => setRenaming(true)}>
        <span className={`prov-mark ${o.provenance.createdBy}`} title={`created by ${o.provenance.createdBy === 'ai' ? 'the AI' : o.provenance.createdBy === 'human' ? 'you' : 'the system'} via ${o.provenance.operation}`}>{mark}</span>
        <span className="obj-title">
          {renaming ? (
            <input
              autoFocus
              defaultValue={o.label}
              onPointerDown={(e) => e.stopPropagation()}
              onBlur={(e) => {
                setRenaming(false);
                if (e.target.value.trim() && e.target.value !== o.label) ui.act([{ op: 'modify_object', id: o.id, label: e.target.value.trim() }]);
              }}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter' || e.key === 'Escape') (e.target as HTMLInputElement).blur();
              }}
            />
          ) : (
            o.label
          )}
        </span>
        {variant && <span className="pill ai" title={`branch assumption: ${o.provenance.assumption}`}>branch</span>}
        <span className="obj-kind">{spec.title.toLowerCase()}</span>
      </div>
      <div className="obj-body">{glance ? <div className="obj-glance">{R.glance!(o, ui.ws)}</div> : <R.body o={o} />}</div>
      {o.kind !== 'group' && <div className="resize" onPointerDown={onResize} />}
      {ports.outputs.length > 0 && <div className="port" title={`${ports.outputs[0].name} — drag onto another object to connect`} onPointerDown={onPort} />}
      {ports.inputs.length > 0 && o.kind !== 'group' && <div className="port in" title={`input: ${ports.inputs.map((p) => p.name).join(', ')}`} />}
      {sugg.length > 0 && ui.detail !== 'glance' && (
        <div className="suggest" onPointerDown={(e) => e.stopPropagation()}>
          {sugg.map((s) => (
            <div key={s.key} className="suggest-item" title={s.text}>
              <span>✦ {s.text}</span>
              <button
                onClick={() => {
                  if (s.action.kind === 'ops') ui.act(s.action.ops, { summary: s.label });
                  else ui.ask(s.action.text, s.action.selection);
                }}
              >
                {s.label}
              </button>
              <button className="x" title="dismiss" onClick={() => ui.dismiss(s.key)}>×</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function GlyphFrame({ g, ws }: { g: TSObject; ws: Workspace }) {
  const members = (g.state.members as string[]).map((id) => ws.objects[id]).filter((m) => m && !m.visual.hidden);
  const all = [g, ...members];
  const x0 = Math.min(...all.map((o) => o.visual.x)) - 18;
  const y0 = Math.min(...all.map((o) => o.visual.y)) - 18;
  const x1 = Math.max(...all.map((o) => o.visual.x + o.visual.w)) + 18;
  const y1 = Math.max(...all.map((o) => o.visual.y + o.visual.h)) + 18;
  return <div className="glyph-frame" style={{ left: x0, top: y0, width: x1 - x0, height: y1 - y0 }} />;
}

// ------------------------------------------------------------------ relations

function anchorOf(ws: Workspace, id: string): TSObject | undefined {
  let o = ws.objects[id];
  let guard = 0;
  while (o && o.visual.hidden && o.parent && guard++ < 5) o = ws.objects[o.parent];
  return o && !o.visual.hidden ? o : undefined;
}

function Relations({ ws, pending }: { ws: Workspace; pending: { from: string; x: number; y: number } | null }) {
  const lines: JSX.Element[] = [];
  const seen = new Set<string>();
  for (const r of Object.values(ws.relations) as Relation[]) {
    if (r.type === 'composed_of' || r.type === 'instance_of' || r.type === 'derived_from') continue;
    // draw in the direction information flows
    const [fromId, toId] = r.type === 'visualizes' || r.type === 'generated_from' || r.type === 'compares_with' ? [r.to, r.from] : [r.from, r.to];
    const a = anchorOf(ws, fromId);
    const b = anchorOf(ws, toId);
    if (!a || !b || a.id === b.id) continue;
    const key = `${a.id}-${b.id}-${r.type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const d = curve(a, b);
    lines.push(
      <g key={r.id}>
        <path className={r.type} d={d.path} markerEnd={r.type === 'feeds_into' || r.type === 'visualizes' ? 'url(#arrow)' : undefined} />
        {r.type === 'branched_from' && typeof r.meta?.assumption === 'string' && (
          <text x={d.mx} y={d.my - 6} textAnchor="middle">{r.meta.assumption as string}</text>
        )}
      </g>,
    );
  }
  if (pending) {
    const a = ws.objects[pending.from];
    if (a) lines.push(<path key="pending" className="pending" d={`M${a.visual.x + a.visual.w},${a.visual.y + a.visual.h / 2} L${pending.x},${pending.y}`} />);
  }
  return (
    <svg className="relations" width={1} height={1}>
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,1 L9,5 L0,9" fill="none" stroke="#a9a597" strokeWidth="1.5" />
        </marker>
      </defs>
      {lines}
    </svg>
  );
}

function curve(a: TSObject, b: TSObject) {
  const A = a.visual, B = b.visual;
  const acx = A.x + A.w / 2, acy = A.y + A.h / 2, bcx = B.x + B.w / 2, bcy = B.y + B.h / 2;
  const horizontal = Math.abs(bcx - acx) > Math.abs(bcy - acy) * 0.8;
  let x1: number, y1: number, x2: number, y2: number, c1x: number, c1y: number, c2x: number, c2y: number;
  if (horizontal) {
    const right = bcx > acx;
    x1 = right ? A.x + A.w : A.x;
    y1 = acy;
    x2 = right ? B.x : B.x + B.w;
    y2 = bcy;
    const k = Math.max(30, Math.abs(x2 - x1) / 2);
    c1x = x1 + (right ? k : -k); c1y = y1; c2x = x2 - (right ? k : -k); c2y = y2;
  } else {
    const down = bcy > acy;
    x1 = acx;
    y1 = down ? A.y + A.h : A.y;
    x2 = bcx;
    y2 = down ? B.y : B.y + B.h;
    const k = Math.max(30, Math.abs(y2 - y1) / 2);
    c1x = x1; c1y = y1 + (down ? k : -k); c2x = x2; c2y = y2 - (down ? k : -k);
  }
  return { path: `M${x1},${y1} C${c1x},${c1y} ${c2x},${c2y} ${x2},${y2}`, mx: (x1 + x2) / 2, my: (y1 + y2) / 2 };
}
