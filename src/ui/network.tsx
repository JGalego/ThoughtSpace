// The neural network as a living object: drag an edge to change its weight, drag a neuron
// to change its bias, double-click a neuron to zoom into its equation.

import { useRef, useState, type JSX } from 'react';
import { ACTIVATIONS, describeArchitecture, layersOf, netParams, networkMetrics, nn, type TSObject } from '../kernel';
import { useUI } from './context';

const SUB = ['₀', '₁', '₂', '₃', '₄', '₅', '₆', '₇', '₈', '₉'];

export function NetworkView({ o }: { o: TSObject }) {
  const ui = useUI();
  const { ws, detail, probe } = ui;
  const layers = layersOf(o);
  const p = netParams(o);
  const m = networkMetrics(ws, o);
  const trace = probe ? nn.forward(p, probe) : null;
  const [hover, setHover] = useState<string | null>(null);
  const drag = useRef<{ kind: 'w' | 'b'; path: number[]; y0: number; v0: number; moved: boolean } | null>(null);

  const W = o.visual.w - 20;
  const H = Math.max(80, o.visual.h - 28 - 58);
  const colX = (l: number) => 22 + (l / (layers.length - 1)) * (W - 44);
  const rowY = (l: number, j: number) => (H / (layers[l] + 1)) * (j + 1);
  const R = Math.max(9, Math.min(14, H / (Math.max(...layers) * 3.2)));

  const start = (e: React.PointerEvent, kind: 'w' | 'b', path: number[], v0: number) => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    drag.current = { kind, path, y0: e.clientY, v0, moved: false };
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dy = d.y0 - e.clientY;
    if (Math.abs(dy) < 2 && !d.moved) return;
    d.moved = true;
    const value = Math.max(-12, Math.min(12, d.v0 + dy * (e.shiftKey ? 0.005 : 0.03)));
    if (d.kind === 'w')
      ui.act([{ op: 'invoke', id: o.id, action: 'set_weight', args: { layer: d.path[0], to: d.path[1], from: d.path[2], value } }], { coalesceKey: `w:${o.id}:${d.path.join(':')}`, summary: `drag w${d.path.join(':')}` });
    else ui.act([{ op: 'invoke', id: o.id, action: 'set_bias', args: { layer: d.path[0], unit: d.path[1], value } }], { coalesceKey: `b:${o.id}:${d.path.join(':')}`, summary: `drag b${d.path.join(':')}` });
  };
  const end = () => {
    drag.current = null;
  };

  const hidden = o.params.hidden as number[];
  const edges: JSX.Element[] = [];
  p.weights.forEach((Wm, l) =>
    Wm.forEach((row, j) =>
      row.forEach((w, i) => {
        const key = `${l}:${j}:${i}`;
        const x1 = colX(l), y1 = rowY(l, i), x2 = colX(l + 1), y2 = rowY(l + 1, j);
        const hi = ui.isHighlighted(o.id, `edge:${key}`) || ui.isHighlighted(o.id, `layer:${l + 1}`);
        const active = trace ? Math.abs(trace.a[l][i] * w) : 1;
        edges.push(
          <g key={key} className="edge" onPointerDown={(e) => start(e, 'w', [l, j, i], w)} onPointerMove={move} onPointerUp={end} onMouseEnter={() => setHover(`w${key} = ${w.toFixed(3)}`)} onMouseLeave={() => setHover(null)}>
            <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={hi ? '#7a5cf0' : w >= 0 ? '#c65d2e' : '#2f6fb3'} strokeWidth={Math.min(7, 0.8 + Math.abs(w) * 1.3)} opacity={trace ? 0.25 + 0.75 * Math.min(1, active) : 0.85} strokeLinecap="round" />
            <line className="edge-hit" x1={x1} y1={y1} x2={x2} y2={y2} />
            {detail === 'detail' && (
              <text className="w" x={x1 + (x2 - x1) * 0.28} y={y1 + (y2 - y1) * 0.28 - 3}>{w.toFixed(2)}</text>
            )}
          </g>,
        );
      }),
    ),
  );

  const neurons: JSX.Element[] = [];
  layers.forEach((n, l) => {
    for (let j = 0; j < n; j++) {
      const cx = colX(l), cy = rowY(l, j);
      const a = trace ? trace.a[l][j] : null;
      const isOut = l === layers.length - 1;
      const hi = l > 0 && (ui.isHighlighted(o.id, `neuron:${l}:${j}`) || ui.isHighlighted(o.id, `layer:${l}`));
      const b = l > 0 ? p.biases[l - 1][j] : 0;
      const fill = a === null ? (l === 0 ? '#f6f5f1' : '#ffffff') : `rgba(107,85,201,${Math.min(1, Math.abs(a)) * 0.75 + 0.05})`;
      neurons.push(
        <g
          key={`n${l}${j}`}
          className={`neuron ${hi ? 'hi' : ''}`}
          onPointerDown={l > 0 ? (e) => start(e, 'b', [l - 1, j], b) : undefined}
          onPointerMove={move}
          onPointerUp={end}
          onDoubleClick={(e) => {
            e.stopPropagation();
            if (l > 0) ui.act([{ op: 'zoom_into', id: o.id, form: 'neuron', focus: `${l}:${j}` }]);
          }}
          onMouseEnter={() => setHover(l === 0 ? `input x${SUB[j + 1]}` : `${isOut ? 'output ŷ' : `h${SUB[l]}${SUB[j + 1]}`} · bias ${b.toFixed(2)} — drag to change, double-click to zoom in`)}
          onMouseLeave={() => setHover(null)}
        >
          <circle cx={cx} cy={cy} r={isOut ? R + 2 : R} fill={fill} strokeDasharray={l === 0 ? '2 2' : undefined} />
          <text x={cx} y={cy + 3.5} textAnchor="middle" style={{ fill: a !== null && Math.abs(a) > 0.55 ? 'white' : undefined }}>
            {l === 0 ? `x${SUB[j + 1]}` : isOut ? 'ŷ' : a !== null ? a.toFixed(1) : o.params.activation === 'relu' ? '⌐' : o.params.activation === 'step' ? '⊓' : '∫'}
          </text>
          {detail === 'detail' && l > 0 && <text className="w" x={cx} y={cy + R + 11} textAnchor="middle">b {b.toFixed(2)}</text>}
          {isOut && a !== null && <text x={cx + R + 6} y={cy + 4}>{a.toFixed(2)}</text>}
        </g>,
      );
    }
  });

  return (
    <div className="net" onPointerDown={(e) => e.stopPropagation()}>
      <svg width={W} height={H} onPointerMove={move} onPointerUp={end}>
        {edges}
        {neurons}
      </svg>
      <div className="spread small" style={{ marginTop: 2, minHeight: 18 }}>
        <span className="muted">{hover ?? `${describeArchitecture(layers)} · drag edges & neurons`}</span>
        {m && <span className={`pill ${m.accuracy === 1 ? 'ok' : 'bad'}`}>{m.correct}/{m.total} correct</span>}
      </div>
      <div className="spread" style={{ marginTop: 4 }}>
        <div className="row">
          <select
            className="inline"
            value={o.params.activation as string}
            title="hidden activation"
            onChange={(e) => ui.act([{ op: 'set_parameter', id: o.id, param: 'activation', value: e.target.value }])}
          >
            {ACTIVATIONS.map((a) => (
              <option key={a}>{a}</option>
            ))}
          </select>
          <button className="btn icon" title="remove a hidden layer" disabled={hidden.length === 0} onClick={() => ui.act([{ op: 'invoke', id: o.id, action: 'remove_layer' }])}>− layer</button>
          <button className="btn icon" title="add a hidden layer of 2 units" disabled={hidden.length >= 3} onClick={() => ui.act([{ op: 'invoke', id: o.id, action: 'add_layer', args: { units: 2 } }])}>+ layer</button>
          {hidden.length > 0 && (
            <>
              <button className="btn icon" title="fewer units in the last hidden layer" disabled={hidden[hidden.length - 1] <= 1} onClick={() => ui.act([{ op: 'invoke', id: o.id, action: 'set_units', args: { index: hidden.length - 1, units: hidden[hidden.length - 1] - 1 } }])}>−u</button>
              <button className="btn icon" title="more units in the last hidden layer" disabled={hidden[hidden.length - 1] >= 8} onClick={() => ui.act([{ op: 'invoke', id: o.id, action: 'set_units', args: { index: hidden.length - 1, units: hidden[hidden.length - 1] + 1 } }])}>+u</button>
            </>
          )}
        </div>
        <div className="row">
          <button className="btn icon" title="re-initialise weights from the seed" onClick={() => ui.act([{ op: 'invoke', id: o.id, action: 'reinitialize' }])}>↺</button>
          <button className="btn primary" disabled={!m} title={m ? 'train deterministically' : 'connect a dataset first'} onClick={() => ui.act([{ op: 'execute', id: o.id }])}>Train ▸</button>
        </div>
      </div>
    </div>
  );
}

export function networkGlance(o: TSObject, ws: import('../kernel').Workspace) {
  const m = networkMetrics(ws, o);
  return (
    <>
      <b>{describeArchitecture(layersOf(o))}</b>
      {m ? `${Math.round(m.accuracy * 100)}% correct` : 'no data'}
    </>
  );
}
