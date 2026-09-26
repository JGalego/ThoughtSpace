// Renderers: pure projections of semantic objects. One per kind; the frame around them is generic.

import { useEffect, useMemo, useState, type JSX } from 'react';
import katex from 'katex';
import {
  ACTIVATIONS,
  arithmeticLatex,
  boundaryLatex,
  datasetFor,
  describeArchitecture,
  formatValue,
  kindSpec,
  layersOf,
  netParams,
  networkLatex,
  networkMetrics,
  neuronLatex,
  nn,
  points,
  relationsFrom,
  resolve,
  sourceOf,
  type ExposedParam,
  type ParamSpec,
  type TSObject,
  type Workspace,
} from '../kernel';
import { useUI } from './context';
import { BoundaryPlot, LineChart, Spark } from './viz';
import { NetworkView, networkGlance } from './network';

export interface Renderer {
  body(props: { o: TSObject }): JSX.Element;
  glance?(o: TSObject, ws: Workspace): JSX.Element | string;
}

// ------------------------------------------------------------------ dataset

function DatasetView({ o }: { o: TSObject }) {
  const ui = useUI();
  const pts = points(o);
  const size = Math.min(o.visual.w - 20, o.visual.h - 56);
  const sep = nn.linearlySeparable(pts);
  // an "identity" network that predicts 0.5 everywhere: the plot shows data only
  const blank = useMemo(() => ({ layers: [2, 1], weights: [[[0, 0]]], biases: [[0]], activation: 'linear' as const }), []);
  return (
    <div>
      <BoundaryPlot plain net={blank} data={pts} size={size} res={4} onFlip={(i) => ui.act([{ op: 'invoke', id: o.id, action: 'flip_label', args: { index: i } }])} onProbe={ui.setProbe} />
      <div className="spread small" style={{ marginTop: 4 }}>
        <select className="inline" value={o.params.preset as string} onChange={(e) => ui.act([{ op: 'set_parameter', id: o.id, param: 'preset', value: e.target.value }])}>
          {['xor', 'and', 'or', 'nand', 'xnor', 'custom'].map((p) => (
            <option key={p} disabled={p === 'custom'}>{p}</option>
          ))}
        </select>
        <span className={`pill ${sep ? 'ok' : ''}`} title="checked deterministically">{sep ? 'linearly separable' : 'not separable by a line'}</span>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ graph

function GraphView({ o }: { o: TSObject }) {
  const ui = useUI();
  const src = sourceOf(ui.ws, o.id);
  const w = o.visual.w - 20;
  if (!src) return <div className="muted small">Not connected. Drag from a network's port onto this plot.</div>;
  const mode = o.params.mode as string;

  if (mode === 'decision_boundary' && src.kind === 'neural_network') {
    const ds = datasetFor(ui.ws, src.id);
    const m = networkMetrics(ui.ws, src);
    const size = Math.min(w, o.visual.h - 56);
    return (
      <div>
        <BoundaryPlot net={netParams(src)} data={points(ds)} size={size} emphasiseBoundary={ui.isHighlighted(o.id, 'boundary')} onProbe={ui.setProbe} onFlip={ds ? (i) => ui.act([{ op: 'invoke', id: ds.id, action: 'flip_label', args: { index: i } }]) : undefined} />
        <div className="spread small" style={{ marginTop: 4 }}>
          <span className="muted">of <span className="link" onClick={() => ui.select([src.id])}>{src.label}</span></span>
          {m && <span className="metric">loss {m.loss.toFixed(3)}</span>}
        </div>
      </div>
    );
  }
  if (mode === 'weight_sweep' && src.kind === 'neural_network') {
    const ds = datasetFor(ui.ws, src.id);
    const path = String(o.params.weight).split(':').map(Number) as [number, number, number];
    if (!ds || src.state.weights[path[0]]?.[path[1]]?.[path[2]] === undefined) return <div className="muted small">weight {String(o.params.weight)} no longer exists</div>;
    const sw = nn.weightSweep(netParams(src), points(ds), path, o.params.span as number);
    const cur = (sw.current - sw.xs[0]) / (sw.xs[sw.xs.length - 1] - sw.xs[0]);
    return (
      <div>
        <div className="small muted" style={{ marginBottom: 12 }}>loss (ink) and accuracy (violet) as w{String(o.params.weight)} varies; dashed = current value {sw.current.toFixed(2)}</div>
        <LineChart series={[sw.loss, sw.acc.map((a) => a * Math.max(...sw.loss))]} width={w} height={o.visual.h - 110} cursor={cur} xLabel={`${sw.xs[0].toFixed(1)} … ${sw.xs[sw.xs.length - 1].toFixed(1)}`} />
      </div>
    );
  }
  if (mode === 'loss_curve') {
    const sim = src.kind === 'simulation' ? src : undefined;
    if (!sim) return <div className="muted small">loss curves visualize a training run</div>;
    return <LineChart series={[sim.state.result.loss]} width={w} height={o.visual.h - 70} xLabel={`${sim.state.config.epochs} epochs`} />;
  }
  if (mode === 'activation' && src.kind === 'function') return <FnPlot fn={src.params.fn as nn.Activation} deriv={!!src.params.derivative} w={w} h={o.visual.h - 60} />;
  return <div className="muted small">{mode} cannot show a {src.kind}</div>;
}

// ------------------------------------------------------------------ function

function FnPlot({ fn, deriv, w, h }: { fn: nn.Activation; deriv: boolean; w: number; h: number }) {
  const [x, setX] = useState<number | null>(null);
  const xs = Array.from({ length: 121 }, (_, i) => -5 + i / 12);
  const lo = fn === 'tanh' || fn === 'linear' ? -1.5 : -0.2;
  const hi = fn === 'relu' || fn === 'linear' ? 3 : 1.2;
  const px = (v: number) => ((v + 5) / 10) * w;
  const py = (v: number) => h - ((Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * h;
  const path = (f: (v: number) => number) => xs.map((v, i) => `${i ? 'L' : 'M'}${px(v).toFixed(1)},${py(f(v)).toFixed(1)}`).join('');
  return (
    <svg width={w} height={h} style={{ display: 'block' }} onMouseMove={(e) => setX(((e.nativeEvent.offsetX / w) * 10) - 5)} onMouseLeave={() => setX(null)}>
      <line x1={0} x2={w} y1={py(0)} y2={py(0)} stroke="#e3e1da" />
      <line x1={px(0)} x2={px(0)} y1={0} y2={h} stroke="#e3e1da" />
      <path d={path((v) => nn.act(fn, v))} fill="none" stroke="#1f1f1d" strokeWidth={1.8} />
      {deriv && <path d={path((v) => nn.dact(fn, v))} fill="none" stroke="#6b55c9" strokeWidth={1.3} strokeDasharray="4 3" />}
      {x !== null && (
        <>
          <circle cx={px(x)} cy={py(nn.act(fn, x))} r={3.5} fill="#1f1f1d" />
          <text x={6} y={12} fontSize="10.5" fill="#55544f">{`f(${x.toFixed(2)}) = ${nn.act(fn, x).toFixed(3)}   f′ = ${nn.dact(fn, x).toFixed(3)}`}</text>
        </>
      )}
    </svg>
  );
}

function FunctionView({ o }: { o: TSObject }) {
  const ui = useUI();
  return (
    <div>
      <FnPlot fn={o.params.fn as nn.Activation} deriv={!!o.params.derivative} w={o.visual.w - 20} h={o.visual.h - 64} />
      <div className="spread small" style={{ marginTop: 4 }}>
        <select className="inline" value={o.params.fn as string} onChange={(e) => ui.act([{ op: 'set_parameter', id: o.id, param: 'fn', value: e.target.value }])}>
          {ACTIVATIONS.map((a) => <option key={a}>{a}</option>)}
        </select>
        <span className="muted">f ink · f′ dashed</span>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ equation

export function Tex({ latex, display = true }: { latex: string; display?: boolean }) {
  const html = useMemo(() => {
    try {
      return katex.renderToString(latex, { displayMode: display, throwOnError: false });
    } catch {
      return latex;
    }
  }, [latex, display]);
  return <div className="eq" dangerouslySetInnerHTML={{ __html: html }} />;
}

export function equationLatex(o: TSObject, ws: Workspace): { latex: string; caption?: string } {
  const form = o.params.form as string;
  if (form === 'custom') return { latex: o.state.latex || '\\text{(empty)}' };
  const src = sourceOf(ws, o.id);
  if (!src || src.kind !== 'neural_network') return { latex: '\\text{not linked to a network}' };
  const p = netParams(src);
  const [L, J] = String(o.params.focus).split(':').map(Number);
  switch (form) {
    case 'neuron':
      return { latex: neuronLatex(p, L, J), caption: 'live: drag the weights and this changes' };
    case 'boundary': {
      const b = boundaryLatex(p);
      return { latex: b.latex, caption: b.kind === 'line' ? 'where ŷ = ½ — always a straight line' : b.kind === 'none' ? 'the network answers ½ everywhere' : 'where ŷ = ½ — hidden units let it bend' };
    }
    case 'network':
      return { latex: networkLatex(p), caption: describeArchitecture(p.layers) };
    case 'arithmetic': {
      const [a, b] = String(o.params.input).split(',').map(Number);
      return { latex: arithmeticLatex(p, L, J, [a || 0, b || 0]), caption: `neuron ${o.params.focus} on input (${a || 0}, ${b || 0})` };
    }
  }
  return { latex: '' };
}

function EquationView({ o }: { o: TSObject }) {
  const ui = useUI();
  const { latex, caption } = equationLatex(o, ui.ws);
  const form = o.params.form as string;
  return (
    <div>
      <Tex latex={latex} />
      <div className="spread small">
        <span className="muted">{caption}</span>
        {form === 'neuron' && (
          <button className="btn icon" title="zoom further: the scalar arithmetic" onClick={() => ui.act([{ op: 'zoom_into', id: sourceOf(ui.ws, o.id)!.id, form: 'arithmetic', focus: o.params.focus, input: '1,0', placement: { below: o.id } }])}>zoom ⤵</button>
        )}
        {form === 'arithmetic' && (
          <select className="inline" value={String(o.params.input)} onChange={(e) => ui.act([{ op: 'set_parameter', id: o.id, param: 'input', value: e.target.value }])}>
            {['0,0', '0,1', '1,0', '1,1'].map((v) => <option key={v}>{v}</option>)}
          </select>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ text

function TextView({ o }: { o: TSObject }) {
  const ui = useUI();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(o.state.text);
  useEffect(() => setDraft(o.state.text), [o.state.text]);
  const target = relationsFrom(ui.ws, o.id, 'annotates')[0];
  return (
    <div className="note-text" onDoubleClick={(e) => { e.stopPropagation(); setEditing(true); }}>
      {target && (
        <div className="small muted" style={{ marginBottom: 3 }}>
          ↳ on <span className="link" onClick={() => ui.select([target.to])}>{ui.ws.objects[target.to]?.label}</span>
          {target.meta?.subtarget ? ` (${String(target.meta.subtarget)})` : ''}
        </div>
      )}
      {editing ? (
        <textarea
          autoFocus
          value={draft}
          onPointerDown={(e) => e.stopPropagation()}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            setEditing(false);
            if (draft !== o.state.text) ui.act([{ op: 'modify_object', id: o.id, state: { text: draft } }]);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') (e.target as HTMLTextAreaElement).blur();
            e.stopPropagation();
          }}
        />
      ) : (
        o.state.text || <span className="muted">double-click to write</span>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ simulation

function SimulationView({ o }: { o: TSObject }) {
  const s = o.state;
  const snaps = s.result.snapshots as nn.Snapshot[];
  const [k, setK] = useState(snaps.length - 1);
  useEffect(() => setK(snaps.length - 1), [snaps.length, s.result.finalLoss]);
  const snap = snaps[Math.min(k, snaps.length - 1)];
  const net = { layers: s.config.layers, activation: s.config.activation, weights: snap.weights, biases: snap.biases };
  const m = nn.evaluate(net, s.config.data);
  const w = o.visual.w - 20;
  const mini = Math.min(96, o.visual.h - 110);
  return (
    <div>
      <div className="row" style={{ alignItems: 'flex-start', gap: 10 }}>
        <BoundaryPlot net={net} data={s.config.data} size={mini} res={24} showAxes={false} />
        <div style={{ flex: 1 }}>
          <LineChart series={[s.result.loss]} width={w - mini - 10} height={mini - 14} cursor={snap.epoch / s.config.epochs} xLabel="epochs" />
        </div>
      </div>
      <input className="scrub" type="range" min={0} max={snaps.length - 1} value={k} onPointerDown={(e) => e.stopPropagation()} onChange={(e) => setK(Number(e.target.value))} />
      <div className="spread small">
        <span className="metric">epoch {snap.epoch} · loss {m.loss.toFixed(3)} · {m.correct}/{m.total}</span>
        <span className={`pill ${s.result.convergedAt ? 'ok' : 'bad'}`}>{s.result.convergedAt ? `converged @${s.result.convergedAt}` : 'did not converge'}</span>
      </div>
      <div className="small muted" style={{ marginTop: 2 }}>
        {describeArchitecture(s.config.layers)} {s.config.activation} · lr {s.config.learningRate} · seed {s.config.seed} · |∇| {s.result.finalGradNorm}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ experiment

function ExperimentView({ o }: { o: TSObject }) {
  const ui = useUI();
  const s = o.state;
  const reps = (s.reproductions ?? []) as { match: boolean; hash: string }[];
  const n = s.seeds.length;
  const best = (s.results as any[]).reduce((b, r, i, a) => (r.summary.success_rate > a[b].summary.success_rate ? i : b), 0);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 4 }}>
      <div style={{ fontSize: 12.5 }}>
        <span className="muted">Hypothesis · </span>
        {s.hypothesis.text}
      </div>
      <div className="small muted">
        vary <b>{s.variable.param}</b> · keep {Object.entries(s.constants).filter(([k]) => !['seeds', 'optimizer', 'output'].includes(k)).map(([k, v]) => `${k}=${Array.isArray(v) ? `[${v}]` : v}`).join(', ')} · {n} seeds · measure loss, accuracy, convergence, |∇|
      </div>
      <div style={{ flex: 1, overflow: 'auto' }}>
        <table className="exp">
          <thead>
            <tr><th>{s.variable.param}</th><th>converged</th><th>best acc</th><th>mean loss</th><th>@epoch</th><th>runs</th></tr>
          </thead>
          <tbody>
            {(s.results as any[]).map((r, i) => (
              <tr key={i} className={i === best && r.summary.success_rate > 0 ? 'win' : ''}>
                <td className="mono">{formatValue(r.value)}</td>
                <td className="mono">{Math.round(r.summary.success_rate * n)}/{n}</td>
                <td className="mono">{Math.round(r.summary.best_accuracy * 100)}%</td>
                <td className="mono">{r.summary.mean_final_loss.toFixed(3)}</td>
                <td className="mono">{r.summary.mean_converged_at ?? '—'}</td>
                <td>
                  <span style={{ position: 'relative', display: 'inline-block', width: 60, height: 16 }}>
                    {r.runs.map((run: any, j: number) => (
                      <span key={j} style={{ position: 'absolute', left: 0, top: 0 }}>
                        <Spark values={run.loss} colour={run.convergedAt ? '#2f8a57' : '#b8433b'} />
                      </span>
                    ))}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        {(s.verdicts as any[]).map((v, i) => (
          <span key={i} className={`pill ${v.holds ? 'ok' : 'bad'}`} title={`observed ${JSON.stringify(v.observed)}`}>
            {v.holds ? '✓' : '✗'} {v.expectation.value !== undefined ? `${formatValue(v.expectation.value)}: ` : ''}{v.expectation.metric} {v.expectation.op} {v.expectation.than !== undefined ? formatValue(v.expectation.than) : v.expectation.threshold}
          </span>
        ))}
      </div>
      <div className="spread small">
        <span className="muted mono" title="hash of all run results">#{s.hash} {reps.length > 0 && (reps.every((r) => r.match) ? `· reproduced ×${reps.length} ✓` : '· reproduction differed ✗')}</span>
        <button className="btn" onClick={() => ui.act([{ op: 'reproduce', id: o.id }])}>Reproduce</button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ comparison

function ComparisonView({ o }: { o: TSObject }) {
  const ui = useUI();
  const A = resolve(ui.ws, o.state.a);
  const B = resolve(ui.ws, o.state.b);
  if (!A || !B) return <div className="muted small">One side of this comparison was deleted.</div>;
  const side = (x: TSObject, other: TSObject) => {
    const diff = (k: string) => JSON.stringify(x.params[k]) !== JSON.stringify(other.params[k]);
    const m = x.kind === 'neural_network' ? networkMetrics(ui.ws, x) : undefined;
    const mo = other.kind === 'neural_network' ? networkMetrics(ui.ws, other) : undefined;
    const size = Math.min(130, (o.visual.w - 40) / 2, o.visual.h - 170);
    return (
      <div>
        <div className="link" style={{ fontWeight: 600, marginBottom: 2 }} onClick={() => ui.select([x.id])}>{x.label}</div>
        {x.provenance.assumption && <div className="small" style={{ color: 'var(--ai)' }}>assumes: {x.provenance.assumption}</div>}
        {x.kind === 'neural_network' && (
          <>
            <BoundaryPlot net={netParams(x)} data={points(datasetFor(ui.ws, x.id))} size={size} res={28} showAxes={false} />
            <div className="kv" style={{ marginTop: 4 }}>
              <span>architecture</span><span className={diff('hidden') ? 'diff mono' : 'mono'}>{describeArchitecture(layersOf(x))}</span>
              <span>activation</span><span className={diff('activation') ? 'diff' : ''}>{String(x.params.activation)}</span>
              <span>seed · lr</span><span className={diff('seed') || diff('learningRate') ? 'diff mono' : 'mono'}>{String(x.params.seed)} · {String(x.params.learningRate)}</span>
              <span>parameters</span><span className="mono">{nn.paramCount(layersOf(x))}</span>
              <span>accuracy</span><span className={m && mo && m.accuracy !== mo.accuracy ? 'diff mono' : 'mono'}>{m ? `${m.correct}/${m.total}` : '—'}</span>
              <span>loss</span><span className="mono">{m ? m.loss.toFixed(3) : '—'}</span>
            </div>
          </>
        )}
        {x.kind !== 'neural_network' && <pre className="json">{JSON.stringify(kindSpec(x.kind)!.summarize(x, ui.ws), null, 1).slice(0, 400)}</pre>}
      </div>
    );
  };
  return (
    <div className="cmp">
      {side(A, B)}
      {side(B, A)}
    </div>
  );
}

// ------------------------------------------------------------------ claim

function ClaimView({ o }: { o: TSObject }) {
  const ui = useUI();
  const s = o.state;
  const ev = (s.evidence as string[]).map((id) => ui.ws.objects[id]).filter(Boolean);
  return (
    <div>
      <span className={`claim-status ${s.status}`}>{s.status === 'supported' ? '✓ supported' : s.status === 'refuted' ? '✗ refuted' : '? unverified'}</span>
      <div className="claim-text">{s.text}</div>
      <div className="small muted">
        {ev.length ? (
          <>evidence: {ev.map((e) => <span key={e.id} className="link" onClick={() => ui.select([e.id])}>{e.label}</span>)}</>
        ) : (
          <>by {o.provenance.createdBy === 'ai' ? 'the AI' : 'you'} · not yet tested</>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ glyph

export function ParamControl({ spec, value, onChange }: { spec: ParamSpec; value: unknown; onChange: (v: unknown) => void }) {
  const [draft, setDraft] = useState(Array.isArray(value) ? value.join(', ') : String(value ?? ''));
  useEffect(() => setDraft(Array.isArray(value) ? value.join(', ') : String(value ?? '')), [value]);
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  if (spec.type === 'enum')
    return (
      <select className="inline" value={String(value)} onPointerDown={stop} onChange={(e) => onChange(e.target.value)}>
        {spec.options!.map((x) => <option key={x}>{x}</option>)}
      </select>
    );
  if (spec.type === 'bool') return <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />;
  if ((spec.type === 'number' || spec.type === 'int') && spec.max !== undefined && spec.max <= 20)
    return (
      <div className="row">
        <input type="range" min={spec.min} max={spec.max} step={spec.step ?? (spec.type === 'int' ? 1 : 0.01)} value={Number(value)} onPointerDown={stop} onChange={(e) => onChange(Number(e.target.value))} style={{ flex: 1 }} />
        <span className="mono" style={{ minWidth: 34, textAlign: 'right' }}>{Number(value).toFixed(spec.type === 'int' ? 0 : 2)}</span>
      </div>
    );
  return (
    <input
      type="text"
      value={draft}
      placeholder={spec.type === 'int_list' ? 'none — e.g. 2 or 3, 2' : undefined}
      onPointerDown={stop}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== (Array.isArray(value) ? value.join(', ') : String(value)) && onChange(spec.type === 'int_list' ? draft : spec.type === 'string' ? draft : Number(draft))}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

function GlyphView({ o }: { o: TSObject }) {
  const ui = useUI();
  const out = resolve(ui.ws, o.id);
  const exposed = o.state.exposed as ExposedParam[];
  const m = out?.kind === 'neural_network' ? networkMetrics(ui.ws, out) : undefined;
  const members = (o.state.members as string[]).map((id) => ui.ws.objects[id]).filter(Boolean);
  return (
    <div>
      {o.state.dataInput && (
        <div className="glyph-port in">
          data {out && datasetFor(ui.ws, out.id) ? <>from <span className="link" onClick={() => ui.select([datasetFor(ui.ws, out.id)!.id])}>{datasetFor(ui.ws, out.id)!.label}</span></> : <span className="muted">— connect a dataset</span>}
        </div>
      )}
      {ui.detail === 'detail' ? (
        <div className="small" style={{ margin: '6px 0' }}>
          <div className="muted">inside:</div>
          {members.map((mm) => (
            <div key={mm.id} className="mono">· {mm.kind} “{mm.label}”{mm.kind === 'neural_network' ? ` ${describeArchitecture(layersOf(mm))}` : ''}</div>
          ))}
        </div>
      ) : (
        <div className="glyph-params">
          {exposed.map((e) => {
            const inner = ui.ws.objects[e.id];
            const spec = inner && kindSpec(inner.kind)!.params.find((p) => p.name === e.param);
            if (!inner || !spec) return null;
            return [
              <span key={`${e.name}-l`} className="muted">{e.name}</span>,
              <ParamControl key={`${e.name}-c`} spec={spec} value={inner.params[e.param]} onChange={(v) => ui.act([{ op: 'set_parameter', id: o.id, param: e.name, value: v }])} />,
            ];
          })}
        </div>
      )}
      {out?.kind === 'neural_network' && (
        <div className="row" style={{ alignItems: 'flex-end', gap: 8 }}>
          <BoundaryPlot net={netParams(out)} data={points(datasetFor(ui.ws, out.id))} size={Math.min(92, o.visual.h - 150)} res={24} showAxes={false} />
          <div style={{ flex: 1 }}>
            <div className="glyph-port">output</div>
            {m && <span className={`pill ${m.accuracy === 1 ? 'ok' : 'bad'}`}>{m.correct}/{m.total}</span>}
          </div>
        </div>
      )}
      <div className="row" style={{ marginTop: 6 }}>
        <button
          className="btn"
          onClick={() => {
            const r = ui.act([{ op: 'expand', id: o.id }]);
            if (r.ok && !o.visual.expanded) ui.focus([o.id, ...(o.state.members as string[])]);
          }}
        >
          {o.visual.expanded ? 'Collapse' : 'Expand'}
        </button>
        {out?.kind === 'neural_network' && <button className="btn primary" onClick={() => ui.act([{ op: 'execute', id: o.id }])}>Train ▸</button>}
        <button className="btn" title="place another instance" onClick={() => ui.act([{ op: 'instantiate_glyph', definition: o.state.definition, placement: { beside: o.id } }])}>+ Copy</button>
      </div>
    </div>
  );
}

function GroupView() {
  return <div />;
}

export const RENDERERS: Record<string, Renderer> = {
  neural_network: { body: NetworkView, glance: networkGlance },
  dataset: { body: DatasetView, glance: (o) => <><b>{String(o.params.preset).toUpperCase()}</b>{o.state.points.length} points</> },
  graph: { body: GraphView, glance: (o) => <><b>▦</b>{String(o.params.mode).replace('_', ' ')}</> },
  function: { body: FunctionView, glance: (o) => <><b>ƒ</b>{String(o.params.fn)}</> },
  equation: { body: EquationView },
  text: { body: TextView },
  simulation: { body: SimulationView, glance: (o) => <><b>{Math.round(o.state.result.finalAccuracy * 100)}%</b>loss {o.state.result.finalLoss}</> },
  experiment: { body: ExperimentView, glance: (o) => <><b>{o.state.supported === null ? '?' : o.state.supported ? '✓' : '✗'}</b>{o.state.hypothesis.text.slice(0, 60)}</> },
  comparison: { body: ComparisonView, glance: () => <><b>⇄</b>comparison</> },
  claim: { body: ClaimView },
  group: { body: GroupView },
  glyph: { body: GlyphView, glance: (o) => <><b>◆</b>{o.label}</> },
};
