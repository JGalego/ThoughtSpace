// Small deterministic visualisations shared by several renderers.

import { useEffect, useMemo, useRef } from 'react';
import { nn } from '../kernel';

type NetParams = import('../kernel/nn').NetParams;
type Point = import('../kernel/nn').Point;

const ZERO = [60, 127, 194];
const ONE = [224, 131, 63];

function colour(p: number): [number, number, number] {
  const s = Math.min(1, Math.abs(p - 0.5) * 2);
  const c = p >= 0.5 ? ONE : ZERO;
  const k = 0.12 + 0.4 * s;
  return [255 * (1 - k) + c[0] * k, 255 * (1 - k) + c[1] * k, 255 * (1 - k) + c[2] * k];
}

/** marching squares over cell-centre samples: segments of the p = 0.5 contour, in grid units */
function contour(grid: Float32Array, res: number): [number, number, number, number][] {
  const segs: [number, number, number, number][] = [];
  const v = (r: number, c: number) => grid[r * res + c] - 0.5;
  for (let r = 0; r < res - 1; r++)
    for (let c = 0; c < res - 1; c++) {
      const a = v(r, c), b = v(r, c + 1), d = v(r + 1, c), e = v(r + 1, c + 1);
      const pts: [number, number][] = [];
      const cross = (p: number, q: number) => p / (p - q);
      if (a * b < 0) pts.push([c + cross(a, b), r]);
      if (b * e < 0) pts.push([c + 1, r + cross(b, e)]);
      if (d * e < 0) pts.push([c + cross(d, e), r + 1]);
      if (a * d < 0) pts.push([c, r + cross(a, d)]);
      if (pts.length >= 2) segs.push([pts[0][0], pts[0][1], pts[1][0], pts[1][1]]);
      if (pts.length === 4) segs.push([pts[2][0], pts[2][1], pts[3][0], pts[3][1]]);
    }
  return segs;
}

export function BoundaryPlot({
  net,
  data,
  size,
  res = 44,
  emphasiseBoundary = false,
  onFlip,
  onProbe,
  showAxes = true,
  plain = false,
}: {
  net: NetParams;
  data: Point[];
  size: number;
  res?: number;
  emphasiseBoundary?: boolean;
  onFlip?: (i: number) => void;
  onProbe?: (p: [number, number] | null) => void;
  showAxes?: boolean;
  /** data only: no model shading, no error marks */
  plain?: boolean;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const dataKey = JSON.stringify(data);
  const dom = useMemo(() => nn.domainFor(data), [dataKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const grid = useMemo(() => nn.decisionGrid(net, dom, res), [net.weights, net.biases, net.activation, dom, res]); // eslint-disable-line react-hooks/exhaustive-deps
  const segs = useMemo(() => contour(grid, res), [grid, res]);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext('2d')!;
    const img = ctx.createImageData(res, res);
    for (let i = 0; i < res * res; i++) {
      const [r, g, b] = plain ? [250, 249, 246] : colour(grid[i]);
      img.data[i * 4] = r;
      img.data[i * 4 + 1] = g;
      img.data[i * 4 + 2] = b;
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }, [grid, res, plain]);

  const sx = (x: number) => ((x - dom.x0) / (dom.x1 - dom.x0)) * size;
  const sy = (y: number) => ((dom.y1 - y) / (dom.y1 - dom.y0)) * size;
  const cell = size / res;
  const preds = data.map((p) => nn.predict(net, p.x));

  return (
    <div className="plot" style={{ position: 'relative', width: size, height: size }}>
      <canvas ref={ref} width={res} height={res} style={{ width: size, height: size, imageRendering: 'auto', filter: 'blur(0.4px)' }} />
      <svg width={size} height={size}>
        {!plain && segs.map((s, i) => (
          <line key={i} x1={(s[0] + 0.5) * cell} y1={(s[1] + 0.5) * cell} x2={(s[2] + 0.5) * cell} y2={(s[3] + 0.5) * cell} stroke={emphasiseBoundary ? '#7a5cf0' : '#2a2a28'} strokeWidth={emphasiseBoundary ? 3 : 1.4} strokeLinecap="round" />
        ))}
        {showAxes && (
          <>
            <text x={size - 4} y={sy(0) - 4} textAnchor="end" fontSize="10" fill="#8b8a84">x₁</text>
            <text x={sx(0) + 4} y={10} fontSize="10" fill="#8b8a84">x₂</text>
          </>
        )}
        {data.map((p, i) => {
          const wrong = !plain && (preds[i] >= 0.5 ? 1 : 0) !== p.y;
          return (
            <g
              key={i}
              className="pt"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onFlip?.(i);
              }}
              onMouseEnter={() => onProbe?.(p.x)}
              onMouseLeave={() => onProbe?.(null)}
            >
              {wrong && <circle cx={sx(p.x[0])} cy={sy(p.x[1])} r={11} fill="none" stroke="#b8433b" strokeWidth={1.5} strokeDasharray="3 2" />}
              <circle cx={sx(p.x[0])} cy={sy(p.x[1])} r={7} fill={p.y ? '#e0833f' : '#3c7fc2'} stroke="white" strokeWidth={2} />
              <title>{`(${p.x.join(', ')}) → label ${p.y}${plain ? '' : `, network says ${preds[i].toFixed(2)}`}${onFlip ? ' — click to flip label' : ''}`}</title>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export function LineChart({
  series,
  width,
  height,
  cursor,
  yMax,
  colours = ['#1f1f1d', '#6b55c9'],
  xLabel,
}: {
  series: number[][];
  width: number;
  height: number;
  cursor?: number; // fraction 0..1
  yMax?: number;
  colours?: string[];
  xLabel?: string;
}) {
  const max = yMax ?? Math.max(1e-6, ...series.flat());
  const path = (s: number[]) =>
    s.map((v, i) => `${i === 0 ? 'M' : 'L'}${((i / Math.max(1, s.length - 1)) * width).toFixed(1)},${(height - (Math.min(v, max) / max) * (height - 4) - 2).toFixed(1)}`).join('');
  return (
    <svg width={width} height={height} style={{ display: 'block', overflow: 'visible' }}>
      <line x1={0} y1={height} x2={width} y2={height} stroke="#e3e1da" />
      {series.map((s, i) => (
        <path key={i} d={path(s)} fill="none" stroke={colours[i % colours.length]} strokeWidth={1.5} opacity={series.length > 3 ? 0.55 : 1} />
      ))}
      {cursor !== undefined && <line x1={cursor * width} x2={cursor * width} y1={0} y2={height} stroke="#6b55c9" strokeDasharray="3 3" />}
      <text x={0} y={-3} fontSize="9.5" fill="#8b8a84">{max.toFixed(2)}</text>
      {xLabel && <text x={width} y={height + 11} fontSize="9.5" fill="#8b8a84" textAnchor="end">{xLabel}</text>}
    </svg>
  );
}

export function Spark({ values, width = 60, height = 16, colour = '#6b55c9' }: { values: number[]; width?: number; height?: number; colour?: string }) {
  if (!values.length) return null;
  const max = Math.max(1e-6, ...values);
  const d = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${((i / Math.max(1, values.length - 1)) * width).toFixed(1)},${(height - (v / max) * height).toFixed(1)}`).join('');
  return (
    <svg width={width} height={height} style={{ display: 'inline-block', verticalAlign: 'middle' }}>
      <path d={d} fill="none" stroke={colour} strokeWidth={1.2} />
    </svg>
  );
}
