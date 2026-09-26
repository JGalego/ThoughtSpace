// Live symbolic projections of a network: the "equation" level of semantic zoom.
// Pure functions of semantic state, so equations can never disagree with the network.

import { act, ACTIVATION_LATEX, forward, type Activation, type NetParams } from './nn';

const fmt = (x: number) => (Math.abs(x) < 0.005 ? '0' : x.toFixed(2));

function term(w: number, sym: string, first: boolean): string {
  const s = w < 0 ? '-' : first ? '' : '+';
  return `${s}${first && w < 0 ? '' : ' '}${fmt(Math.abs(w))}\\,${sym}`.trim();
}

export function unitName(layers: number[], L: number, J: number): string {
  if (L === 0) return `x_{${J + 1}}`;
  if (L === layers.length - 1) return '\\hat{y}';
  return `h^{(${L})}_{${J + 1}}`;
}

export function activationOf(net: NetParams, L: number): Activation {
  return L === net.layers.length - 1 ? 'sigmoid' : net.activation;
}

/** y = f(Σ w x + b) for neuron J of layer L (L ≥ 1) */
export function neuronLatex(net: NetParams, L: number, J: number): string {
  const W = net.weights[L - 1]?.[J];
  if (!W) return '\\text{no such neuron}';
  const terms = W.map((w, i) => term(w, unitName(net.layers, L - 1, i), i === 0)).join(' ');
  const b = net.biases[L - 1][J];
  return `${unitName(net.layers, L, J)} = ${ACTIVATION_LATEX[activationOf(net, L)]}\\!\\left(${terms} ${b < 0 ? '-' : '+'} ${fmt(Math.abs(b))}\\right)`;
}

/** the set where the network output is exactly 1/2 */
export function boundaryLatex(net: NetParams): { latex: string; kind: 'line' | 'curve' | 'none' } {
  if (net.weights.length === 1) {
    const [w1, w2] = net.weights[0][0];
    const b = net.biases[0][0];
    if (Math.abs(w1) < 1e-9 && Math.abs(w2) < 1e-9) return { latex: '\\text{no boundary: both weights are 0}', kind: 'none' };
    const eq = `${term(w1, 'x_1', true)} ${term(w2, 'x_2', false)} ${b < 0 ? '-' : '+'} ${fmt(Math.abs(b))} = 0`;
    const line = Math.abs(w2) > 1e-9 ? `\\;\\Longleftrightarrow\\; x_2 = ${fmt(-w1 / w2)}\\,x_1 ${-b / w2 < 0 ? '-' : '+'} ${fmt(Math.abs(b / w2))}` : '';
    return { latex: `${eq}${line}`, kind: 'line' };
  }
  const L = net.layers.length - 1;
  const hidden = net.weights[L - 1][0].map((v, j) => `${term(v, unitName(net.layers, L - 1, j), j === 0)}`).join(' ');
  const c = net.biases[L - 1][0];
  return { latex: `${hidden} ${c < 0 ? '-' : '+'} ${fmt(Math.abs(c))} = 0 \\quad(\\text{each } h \\text{ bends the line})`, kind: 'curve' };
}

export function networkLatex(net: NetParams): string {
  if (net.weights.length === 1) return neuronLatex(net, 1, 0);
  const f = ACTIVATION_LATEX[net.activation];
  const parts: string[] = [];
  for (let L = 1; L < net.layers.length; L++) {
    const W = `W^{(${L})}`;
    const prev = L === 1 ? '\\mathbf{x}' : `\\mathbf{h}^{(${L - 1})}`;
    const out = L === net.layers.length - 1 ? '\\hat{y}' : `\\mathbf{h}^{(${L})}`;
    parts.push(`${out} = ${L === net.layers.length - 1 ? '\\sigma' : f}(${W}${prev} + \\mathbf{b}^{(${L})})`);
  }
  return parts.join(',\\quad ');
}

/** the scalar arithmetic of one neuron on one input — the bottom of semantic zoom */
export function arithmeticLatex(net: NetParams, L: number, J: number, input: [number, number]): string {
  const t = forward(net, input);
  const W = net.weights[L - 1]?.[J];
  if (!W) return '\\text{no such neuron}';
  const prev = t.a[L - 1];
  const products = W.map((w, i) => `(${fmt(w)})(${fmt(prev[i])})`).join(' + ');
  const z = t.z[L][J];
  const f = activationOf(net, L);
  return `z = ${products} + (${fmt(net.biases[L - 1][J])}) = ${fmt(z)},\\quad ${ACTIVATION_LATEX[f]}(${fmt(z)}) = ${act(f, z).toFixed(3)}`;
}
