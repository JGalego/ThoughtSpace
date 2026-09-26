// Renderers for the open-lesson kinds: sliders, live formulas, systems of equations,
// random trials, and the charts and experiments built on them. Everything shown is
// computed by the kernel from the semantic objects; the UI only draws and dispatches.

import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import {
  fmt,
  measure,
  nameTex,
  parseExpr,
  relationsFrom,
  scalarOf,
  sweep,
  systemOf,
  toLatex,
  trialsOf,
  variablesBehind,
  type SystemVar,
  type TSObject,
  type Workspace,
} from '../kernel';
import { useUI } from './context';
import { Tex } from './tex';

export const PALETTE = ['#1f1f1d', '#6b55c9', '#c65d2e', '#2f8a57', '#2f6fb3', '#b8433b', '#8a6d1f'];

const stop = (e: React.SyntheticEvent) => e.stopPropagation();

function latexOf(src: string): string {
  try {
    return toLatex(parseExpr(src));
  } catch {
    return `\\text{${src.replace(/[\\{}$&#^_%~]/g, ' ')}}`;
  }
}

function unitTex(u: unknown): string {
  return u ? `\\;\\mathrm{${String(u).replace(/[\\{}$&#^_%~]/g, (c) => (c === '%' ? '\\%' : ' '))}}` : '';
}

/** floating-point dust (−9e−11 where the exact answer is 0) reads as 0 */
const tidy = (x: number | undefined) => (x !== undefined && Math.abs(x) < 1e-9 ? 0 : x);

/** a number as TeX: 1.23 × 10^{-5} instead of 1.23e-5 */
function numTex(x: number | undefined): string {
  const s = fmt(tidy(x), 4);
  const m = /^(-?[\d.]+)e([+-]?\d+)$/.exec(s);
  return m ? `${m[1]} \\times 10^{${Number(m[2])}}` : s.replace('∞', '\\infty');
}

// ------------------------------------------------------------------ inline editing

function useInlineEdit(value: string, commit: (v: string) => string | undefined) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string>();
  useEffect(() => setDraft(value), [value]);
  const done = () => {
    if (draft.trim() === value) return setEditing(false), setError(undefined);
    const err = commit(draft.trim());
    setError(err);
    if (!err) setEditing(false);
  };
  const input = (
    <input
      className="calc-edit"
      autoFocus
      value={draft}
      spellCheck={false}
      onPointerDown={stop}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={done}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') done();
        if (e.key === 'Escape') setDraft(value), setEditing(false), setError(undefined);
      }}
    />
  );
  return { editing, start: () => setEditing(true), input, error };
}

// ------------------------------------------------------------------ variable

export function VariableView({ o }: { o: TSObject }) {
  const ui = useUI();
  const v = Number(o.params.value);
  const min = Number(o.params.min);
  const max = Number(o.params.max);
  const step = Number(o.params.step) || (max - min) / 200;
  const set = (value: number) => ui.act([{ op: 'set_parameter', id: o.id, param: 'value', value }], { coalesceKey: `slide:${o.id}` });
  const edit = useInlineEdit(String(v), (s) => {
    const n = Number(s);
    if (!Number.isFinite(n)) return 'a number, please';
    const r = ui.act([{ op: 'set_parameter', id: o.id, param: 'value', value: n }]);
    return r.ok ? undefined : r.errors[0];
  });
  return (
    <div className="calc-var">
      <div className="spread">
        <span className="calc-name"><Tex display={false} latex={nameTex(o.state.name)} /></span>
        <span className="calc-value" onDoubleClick={(e) => (stop(e), edit.start())} title="double-click to type a value">
          {edit.editing ? edit.input : <>{fmt(v, 4)}{o.state.unit ? <span className="muted"> {o.state.unit}</span> : null}</>}
        </span>
      </div>
      <input className="slider" type="range" min={min} max={max} step={step} value={v} onPointerDown={stop} onChange={(e) => set(Number(e.target.value))} />
      <div className="spread small muted">
        <span className="mono">{fmt(min)}</span>
        {edit.error ? <span className="calc-error">{edit.error}</span> : o.state.description ? <span className="calc-desc">{o.state.description}</span> : null}
        <span className="mono">{fmt(max)}</span>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ formula

export function FormulaView({ o }: { o: TSObject }) {
  const ui = useUI();
  const r = useMemo(() => scalarOf(ui.ws, o), [ui.ws, o]);
  const edit = useInlineEdit(o.state.expr, (expr) => {
    const res = ui.act([{ op: 'modify_object', id: o.id, state: { expr } }]);
    return res.ok ? undefined : res.errors[0];
  });
  const lhs = nameTex(o.state.name);
  return (
    <div className="calc-formula" onDoubleClick={(e) => (stop(e), edit.start())} title="double-click to edit the formula">
      {edit.editing ? (
        <div className="row"><span className="mono">{o.state.name} =</span>{edit.input}</div>
      ) : (
        <Tex latex={`${lhs} = ${latexOf(o.state.expr)}${r.ok ? ` = \\mathbf{${numTex(r.value)}}${unitTex(o.state.unit)}` : ''}`} />
      )}
      {edit.error && <div className="calc-error">{edit.error}</div>}
      {!r.ok && !edit.error && <div className="calc-error">{r.error}</div>}
      {o.state.description && <div className="small muted">{o.state.description}</div>}
    </div>
  );
}

// ------------------------------------------------------------------ system

export function SystemView({ o }: { o: TSObject }) {
  const ui = useUI();
  const r = useMemo(() => systemOf(ui.ws, o), [ui.ws, o]);
  const vars = o.state.vars as SystemVar[];
  const helpers = (o.state.helpers ?? []) as { name: string; expr: string }[];
  const lines = [
    ...helpers.map((h) => `${nameTex(h.name)} &= ${latexOf(h.expr)}`),
    ...vars.map((v) => `\\frac{d${nameTex(v.name)}}{dt} &= ${latexOf(v.rate)}`),
  ];
  const inits = vars.map((v) => `${nameTex(v.name)}(0) = ${latexOf(v.init)}`).join(',\\quad ');
  const w = o.visual.w - 20;
  return (
    <div className="calc-system">
      <Tex latex={`\\begin{aligned}${lines.join(' \\\\ ')}\\end{aligned}`} />
      <div className="small muted row" style={{ flexWrap: 'wrap', gap: 10 }}>
        <span>start: <Tex display={false} latex={inits} /></span>
        {o.state.stop && <span>stops when <Tex display={false} latex={latexOf(o.state.stop)} /></span>}
      </div>
      {r.ok ? (
        <>
          <div className="calc-outs">
            {vars.slice(0, 4).map((v, i) => (
              <span key={v.name} className="mono" style={{ color: PALETTE[i % PALETTE.length] }}>
                {v.name}<sub>end</sub> {fmt(tidy(r.value.outputs[`${v.name}_end`]))} · max {fmt(tidy(r.value.outputs[`${v.name}_max`]))}
              </span>
            ))}
            <span className="mono muted">t {r.value.stoppedAt !== null ? `stopped at ${fmt(r.value.stoppedAt)}` : `0 … ${fmt(r.value.outputs.t_end)}`}</span>
          </div>
          <MiniSeries run={r.value} names={vars.map((v) => v.name)} width={w} height={Math.max(24, o.visual.h - 84 - 26 * lines.length - 17 * Math.min(4, vars.length + 1))} />
        </>
      ) : (
        <div className="calc-error">{r.error}</div>
      )}
    </div>
  );
}

function MiniSeries({ run, names, width, height }: { run: { t: number[]; series: Record<string, number[]> }; names: string[]; width: number; height: number }) {
  if (height < 24) return null;
  return <Chart width={width} height={height} compact lines={names.map((n, i) => ({ xs: run.t, ys: run.series[n], colour: PALETTE[i % PALETTE.length], label: n }))} />;
}

// ------------------------------------------------------------------ trials

export function TrialsView({ o }: { o: TSObject }) {
  const ui = useUI();
  const r = useMemo(() => trialsOf(ui.ws, o), [ui.ws, o]);
  const edit = useInlineEdit(o.state.expr, (expr) => {
    const res = ui.act([{ op: 'modify_object', id: o.id, state: { expr } }]);
    return res.ok ? undefined : res.errors[0];
  });
  const w = o.visual.w - 20;
  return (
    <div className="calc-trials">
      <div onDoubleClick={(e) => (stop(e), edit.start())} title="double-click to edit what one trial computes">
        {edit.editing ? <div className="row"><span className="mono">{o.state.name} =</span>{edit.input}</div> : <Tex latex={`${nameTex(o.state.name)} = ${latexOf(o.state.expr)}`} />}
      </div>
      {edit.error && <div className="calc-error">{edit.error}</div>}
      {r.ok ? (
        <>
          <Histogram run={r.value} width={w} height={Math.max(40, o.visual.h - 150)} compact />
          <div className="spread small">
            <span className="mono">mean {fmt(r.value.stats.mean)} · sd {fmt(r.value.stats.sd)} · skew {fmt(r.value.stats.skew, 2)}</span>
            <button className="btn icon" title="draw a fresh set of random numbers (new seed)" onClick={() => ui.act([{ op: 'set_parameter', id: o.id, param: 'seed', value: Number(o.params.seed) + 1 }])}>
              🎲 {String(o.params.trials)}×
            </button>
          </div>
        </>
      ) : (
        <div className="calc-error">{r.error}</div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ charts

interface Line {
  xs: number[];
  ys: number[];
  colour: string;
  label: string;
  marker?: [number, number];
}

function niceTicks(lo: number, hi: number, n = 4): number[] {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi + step * 1e-9; t += step) out.push(Math.abs(t) < step * 1e-9 ? 0 : t);
  return out;
}

function extent(vals: number[], pad = 0.06): [number, number] {
  const f = vals.filter(Number.isFinite);
  if (!f.length) return [0, 1];
  let lo = Math.min(...f);
  let hi = Math.max(...f);
  if (hi - lo < 1e-12) (lo -= Math.abs(lo) * 0.1 || 1), (hi += Math.abs(hi) * 0.1 || 1);
  const p = (hi - lo) * pad;
  return [lo - p, hi + p];
}

export function Chart({
  lines,
  bars,
  width,
  height,
  xLabel,
  cursorX,
  onPick,
  compact = false,
  xDomain,
}: {
  lines: Line[];
  bars?: { edges: number[]; counts: number[] };
  width: number;
  height: number;
  xLabel?: string;
  cursorX?: number;
  onPick?: (x: number) => void;
  compact?: boolean;
  xDomain?: [number, number];
}): JSX.Element {
  const ml = compact ? 4 : 38;
  const mb = compact ? 4 : 18;
  const mt = 6;
  const W = Math.max(40, width - ml - 4);
  const H = Math.max(20, height - mb - mt);
  const allX = [...lines.flatMap((l) => l.xs), ...(bars ? [bars.edges[0], bars.edges[bars.edges.length - 1]] : [])];
  const [x0, x1] = xDomain ?? extent(allX, 0);
  const ys = [...lines.flatMap((l) => l.ys), ...(bars ? [0, ...bars.counts] : [])];
  let [y0, y1] = extent(ys);
  if (bars) y0 = 0;
  const sx = (x: number) => ml + ((x - x0) / (x1 - x0 || 1)) * W;
  const sy = (y: number) => mt + ((y1 - Math.max(y0 - (y1 - y0), Math.min(y1 + (y1 - y0), y))) / (y1 - y0 || 1)) * H;
  const dragging = useRef(false);
  const pick = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!onPick) return;
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * width;
    onPick(x0 + (Math.max(0, Math.min(W, px - ml)) / W) * (x1 - x0));
  };
  const path = (l: Line) => {
    let d = '';
    let pen = false;
    l.xs.forEach((x, i) => {
      const y = l.ys[i];
      if (!Number.isFinite(y)) return void (pen = false);
      d += `${pen ? 'L' : 'M'}${sx(x).toFixed(1)},${sy(y).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  return (
    <svg
      width={width}
      height={height}
      className={`chart ${onPick ? 'pickable' : ''}`}
      onPointerDown={(e) => {
        if (!onPick) return;
        e.stopPropagation();
        dragging.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        pick(e);
      }}
      onPointerMove={(e) => dragging.current && pick(e)}
      onPointerUp={() => (dragging.current = false)}
    >
      {!compact &&
        niceTicks(y0, y1).map((t) => (
          <g key={`y${t}`}>
            <line x1={ml} x2={ml + W} y1={sy(t)} y2={sy(t)} stroke="#efede7" />
            <text x={ml - 4} y={sy(t) + 3} textAnchor="end" className="tick">{fmt(t, 3)}</text>
          </g>
        ))}
      {!compact &&
        niceTicks(x0, x1, Math.max(2, Math.floor(W / 70))).map((t) => (
          <text key={`x${t}`} x={sx(t)} y={mt + H + 12} textAnchor="middle" className="tick">{fmt(t, 3)}</text>
        ))}
      {y0 < 0 && y1 > 0 && <line x1={ml} x2={ml + W} y1={sy(0)} y2={sy(0)} stroke="#cfccc3" />}
      <line x1={ml} x2={ml + W} y1={mt + H} y2={mt + H} stroke="#cfccc3" />
      {bars &&
        bars.counts.map((c, i) => (
          <rect key={i} x={sx(bars.edges[i]) + 0.5} y={sy(c)} width={Math.max(1, sx(bars.edges[i + 1]) - sx(bars.edges[i]) - 1)} height={Math.max(0, mt + H - sy(c))} fill="#d9d3f3" stroke="#b9aeea" strokeWidth={0.6} />
        ))}
      {lines.map((l, i) => (
        <path key={i} d={path(l)} fill="none" stroke={l.colour} strokeWidth={1.7} strokeLinejoin="round" />
      ))}
      {cursorX !== undefined && cursorX >= x0 && cursorX <= x1 && <line x1={sx(cursorX)} x2={sx(cursorX)} y1={mt} y2={mt + H} stroke="#6b55c9" strokeDasharray="3 3" />}
      {lines.map((l, i) => l.marker && Number.isFinite(l.marker[1]) && <circle key={`m${i}`} cx={sx(l.marker[0])} cy={sy(l.marker[1])} r={4.5} fill={l.colour} stroke="white" strokeWidth={1.5} />)}
      {!compact && lines.length > 1 && (
        <g>
          {lines.map((l, i) => (
            <text key={i} x={ml + W - 2} y={mt + 10 + i * 12} textAnchor="end" className="legend" fill={l.colour}>{l.label}</text>
          ))}
        </g>
      )}
      {xLabel && !compact && <text x={ml + W} y={mt + H - 4} textAnchor="end" className="axis-label">{xLabel}</text>}
    </svg>
  );
}

function Histogram({ run, width, height, compact }: { run: { hist: { edges: number[]; counts: number[] }; stats: Record<string, number>; values: number[] }; width: number; height: number; compact?: boolean }) {
  const { edges } = run.hist;
  const { mean, sd } = run.stats;
  const n = run.values.length;
  const bw = edges[1] - edges[0];
  // the normal curve with the same mean and sd, scaled to counts: the CLT made visible
  const normal = sd > 0 && edges.length > 2 ? Array.from({ length: 81 }, (_, i) => edges[0] + ((edges[edges.length - 1] - edges[0]) * i) / 80) : [];
  const lines = normal.length ? [{ xs: normal, ys: normal.map((x) => ((n * bw) / (sd * Math.sqrt(2 * Math.PI))) * Math.exp(-((x - mean) ** 2) / (2 * sd * sd))), colour: '#c65d2e', label: 'normal' }] : [];
  return <Chart width={width} height={height} bars={run.hist} lines={lines} cursorX={mean} compact={compact} />;
}

// ------------------------------------------------------------------ graph modes

export function CalcGraph({ o }: { o: TSObject }): JSX.Element {
  const ui = useUI();
  const sources = relationsFrom(ui.ws, o.id, 'visualizes').map((r) => ui.ws.objects[r.to]).filter(Boolean) as TSObject[];
  const w = o.visual.w - 20;
  const h = o.visual.h - 60;
  const mode = o.params.mode as string;
  if (!sources.length) return <div className="muted small">Not connected.</div>;

  if (mode === 'curve') return <CurvePlot o={o} sources={sources.filter((s) => s.kind === 'formula')} w={w} h={h} />;
  if (mode === 'series') {
    const s = sources.find((x) => x.kind === 'system');
    if (!s) return <div className="muted small">a time series shows a system</div>;
    const r = systemOf(ui.ws, s);
    if (!r.ok) return <div className="calc-error">{r.error}</div>;
    const x = String(o.params.x || 't');
    const ys = String(o.params.y || '').split(',').filter(Boolean);
    const names = ys.length ? ys : (s.state.vars as SystemVar[]).map((v) => v.name);
    const col = (n: string) => (n === 't' ? r.value.t : r.value.series[n]);
    return (
      <div>
        <Chart width={w} height={h - 14} xLabel={x} lines={names.map((n, i) => ({ xs: col(x), ys: col(n), colour: PALETTE[i % PALETTE.length], label: n }))} />
        <div className="small muted">{names.join(', ')} vs {x} · of <span className="link" onClick={() => ui.select([s.id])}>{s.label}</span></div>
      </div>
    );
  }
  if (mode === 'histogram') {
    const s = sources.find((x) => x.kind === 'trials');
    if (!s) return <div className="muted small">a histogram shows random trials</div>;
    const r = trialsOf(ui.ws, s);
    if (!r.ok) return <div className="calc-error">{r.error}</div>;
    return (
      <div>
        <Histogram run={r.value} width={w} height={h - 14} />
        <div className="spread small">
          <span className="muted">{r.value.values.length} trials of <span className="link" onClick={() => ui.select([s.id])}>{s.state.name}</span> · dashed = mean · orange = normal curve</span>
          <span className="mono">sd {fmt(r.value.stats.sd)}</span>
        </div>
      </div>
    );
  }
  return <div className="muted small">{mode} cannot show a {sources[0].kind}</div>;
}

function CurvePlot({ o, sources, w, h }: { o: TSObject; sources: TSObject[]; w: number; h: number }) {
  const ui = useUI();
  const x = String(o.params.x);
  const variable = sources.flatMap((s) => variablesBehind(ui.ws, s.id)).find((v) => v.state.name === x);
  const from = Number(o.params.from);
  const to = Number(o.params.to);
  const [lo, hi] = from === 0 && to === 0 && variable ? [Number(variable.params.min), Number(variable.params.max)] : [from, to];
  const cur = variable ? Number(variable.params.value) : undefined;
  const curves = useMemo(
    () =>
      sources.map((s, i) => {
        const r = sweep(ui.ws, s, x, lo, hi, 160);
        const at = cur !== undefined ? scalarOf(ui.ws, s) : undefined;
        return { s, r, line: r.ok ? { xs: r.value.xs, ys: r.value.ys, colour: PALETTE[i % PALETTE.length], label: s.state.name, marker: at?.ok && cur !== undefined ? ([cur, at.value] as [number, number]) : undefined } : undefined };
      }),
    [ui.ws, sources, x, lo, hi, cur], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const bad = curves.find((c) => !c.r.ok);
  if (!variable) return <div className="calc-error">x = {x} is no longer a slider these formulas use</div>;
  return (
    <div>
      <Chart
        width={w}
        height={h - 14}
        xLabel={x}
        xDomain={[lo, hi]}
        lines={curves.flatMap((c) => (c.line ? [c.line] : []))}
        cursorX={cur}
        onPick={(v) => {
          const step = Number(variable.params.step) || 0;
          const snapped = step > 0 ? Math.round(v / step) * step : +v.toPrecision(4);
          ui.act([{ op: 'set_parameter', id: variable.id, param: 'value', value: snapped }], { coalesceKey: `slide:${variable.id}` });
        }}
      />
      <div className="spread small">
        <span className="muted">drag along the curve to move <b>{x}</b></span>
        <span className="mono">{curves.map((c) => (c.line?.marker ? `${c.s.state.name} ${fmt(c.line.marker[1])}` : '')).filter(Boolean).join(' · ')}</span>
      </div>
      {bad && !bad.r.ok && <div className="calc-error">{bad.r.error}</div>}
    </div>
  );
}

// ------------------------------------------------------------------ experiments

export function CalcExperimentView({ o }: { o: TSObject }) {
  const ui = useUI();
  const s = o.state;
  const results = s.results as { value: number; metrics: Record<string, number>; spread?: Record<string, number> }[];
  const reps = (s.reproductions ?? []) as { match: boolean }[];
  const focus = s.focus as string;
  const keys = [focus, ...Object.keys(results[0]?.metrics ?? {}).filter((k) => k !== focus)].slice(0, 4);
  const consts = Object.entries(s.constants as Record<string, number>);
  const w = o.visual.w - 20;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 4 }}>
      <div style={{ fontSize: 12.5 }}>
        <span className="muted">Hypothesis · </span>
        {s.hypothesis.text}
      </div>
      <div className="small muted">
        vary <b>{s.variable.param}</b>{consts.length ? ` · keep ${consts.map(([k, v]) => `${k}=${fmt(v)}`).join(', ')}` : ''}
        {s.seeds.length > 1 ? ` · ${s.seeds.length} random seeds, averaged` : ''}
      </div>
      <div className="row" style={{ alignItems: 'stretch', gap: 8, flex: 1, minHeight: 0 }}>
        <div style={{ flex: 1, overflow: 'auto' }}>
          <table className="exp">
            <thead>
              <tr>
                <th>{s.variable.param}</th>
                {keys.map((k) => <th key={k}>{k}</th>)}
              </tr>
            </thead>
            <tbody>
              {results.map((r, i) => (
                <tr key={i}>
                  <td className="mono">{fmt(r.value)}</td>
                  {keys.map((k) => (
                    <td key={k} className="mono" title={r.spread ? `± ${fmt(r.spread[k])} across seeds` : undefined}>{fmt(r.metrics[k], 4)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {results.length > 1 && (
          <div style={{ width: Math.min(170, w * 0.4), flex: 'none' }}>
            <Chart width={Math.min(170, w * 0.4)} height={110} xLabel={s.variable.param} lines={[{ xs: results.map((r) => r.value), ys: results.map((r) => r.metrics[focus]), colour: '#6b55c9', label: focus }]} />
            <div className="small muted" style={{ textAlign: 'center' }}>{focus}</div>
          </div>
        )}
      </div>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        {(s.verdicts as any[]).map((v, i) => (
          <span key={i} className={`pill ${v.holds ? 'ok' : 'bad'}`} title={`observed ${v.observed.map((x: number) => fmt(x, 4)).join(', ')}`}>
            {v.holds ? '✓' : '✗'} {v.expectation.value !== undefined ? `at ${fmt(v.expectation.value)}: ` : ''}
            {v.expectation.metric} {v.expectation.op} {v.expectation.than !== undefined ? `its value at ${fmt(v.expectation.than)}` : fmt(v.expectation.threshold)}
          </span>
        ))}
        {!(s.verdicts as any[]).length && <span className="pill">no prediction to test: results only</span>}
      </div>
      <div className="spread small">
        <span className="muted mono" title="hash of all results">#{s.hash} {reps.length > 0 && (reps.every((r) => r.match) ? `· reproduced ×${reps.length} ✓` : '· reproduction differed ✗')}</span>
        <button className="btn" onClick={() => ui.act([{ op: 'reproduce', id: o.id }])}>Reproduce</button>
      </div>
    </div>
  );
}

/** metrics side by side, for comparing two variants of a calc object */
export function calcMetrics(ws: Workspace, o: TSObject): Record<string, number> | undefined {
  if (o.kind === 'variable') return { [o.state.name]: Number(o.params.value) };
  const r = measure(ws, o);
  return r.ok ? r.value : undefined;
}

// ------------------------------------------------------------------ glances

export const calcGlance = {
  variable: (o: TSObject) => (<><b>{fmt(Number(o.params.value), 4)}</b>{o.state.name}{o.state.unit ? ` (${o.state.unit})` : ''}</>),
  formula: (o: TSObject, ws: Workspace) => {
    const r = scalarOf(ws, o);
    return <><b>{r.ok ? fmt(r.value, 4) : '⚠'}</b>{o.state.name}{o.state.unit ? ` (${o.state.unit})` : ''}</>;
  },
  system: (o: TSObject) => (<><b>∂</b>{o.state.name}</>),
  trials: (o: TSObject, ws: Workspace) => {
    const r = trialsOf(ws, o);
    return <><b>{r.ok ? fmt(r.value.stats.mean, 3) : '⚠'}</b>mean {o.state.name}</>;
  },
};
