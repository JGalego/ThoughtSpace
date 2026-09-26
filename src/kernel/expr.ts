// A small, safe expression language for formulas, systems and random trials.
// Parsed to an AST (never eval'd), evaluated deterministically (randomness comes from a
// seeded generator), typeset as LaTeX, and able to report which names it depends on.
//
//   range = v^2 * sin(2*rad(theta)) / g
//   S = sum(k, 1, n, sin((2k-1)*x) / (2k-1))
//   mean = meanof(n, -ln(1 - rand()))

export type Ast =
  | { t: 'num'; v: number }
  | { t: 'name'; n: string }
  | { t: 'un'; op: '-' | '+' | '!'; a: Ast }
  | { t: 'bin'; op: string; a: Ast; b: Ast }
  | { t: 'cond'; c: Ast; a: Ast; b: Ast }
  | { t: 'call'; f: string; args: Ast[] };

export class ExprError extends Error {}

const err = (m: string): never => {
  throw new ExprError(m);
};

// ------------------------------------------------------------------ tokens

type Tok = { k: 'num'; v: number } | { k: 'id'; v: string } | { k: 'op'; v: string } | { k: 'end' };

const OPS = ['**', '<=', '>=', '==', '!=', '&&', '||', '+', '-', '*', '/', '^', '%', '(', ')', ',', '<', '>', '!', '?', ':'];
const SYNONYMS: Record<string, string> = { '·': '*', '×': '*', '÷': '/', '−': '-', '≤': '<=', '≥': '>=', '≠': '!=', '**': '^' };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const num = /^(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/.exec(src.slice(i));
    if (num) {
      out.push({ k: 'num', v: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    const id = /^[\p{L}_][\p{L}\p{N}_]*/u.exec(src.slice(i));
    if (id) {
      out.push({ k: 'id', v: id[0] });
      i += id[0].length;
      continue;
    }
    if (SYNONYMS[c]) {
      out.push({ k: 'op', v: SYNONYMS[c] });
      i++;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) return err(`unexpected character "${c}"`);
    out.push({ k: 'op', v: SYNONYMS[op] ?? op });
    i += op.length;
  }
  out.push({ k: 'end' });
  return out;
}

// ------------------------------------------------------------------ parser (Pratt)

const BIN: Record<string, [number, 'l' | 'r']> = {
  '||': [1, 'l'],
  '&&': [2, 'l'],
  '==': [3, 'l'],
  '!=': [3, 'l'],
  '<': [4, 'l'],
  '>': [4, 'l'],
  '<=': [4, 'l'],
  '>=': [4, 'l'],
  '+': [5, 'l'],
  '-': [5, 'l'],
  '*': [6, 'l'],
  '/': [6, 'l'],
  '%': [6, 'l'],
  '^': [8, 'r'],
};

export function parse(src: string): Ast {
  if (typeof src !== 'string' || !src.trim()) return err('empty expression');
  if (src.length > 2000) return err('expression too long');
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];
  const isOp = (v: string) => peek().k === 'op' && (peek() as { v: string }).v === v;
  const expect = (v: string) => (isOp(v) ? next() : err(`expected "${v}"`));

  function primary(): Ast {
    const t = next();
    if (t.k === 'num') return implicit({ t: 'num', v: t.v });
    if (t.k === 'id') {
      if (isOp('(')) {
        next();
        const args: Ast[] = [];
        if (!isOp(')')) {
          do args.push(expr(0));
          while (isOp(',') && next());
        }
        expect(')');
        return implicit({ t: 'call', f: t.v, args });
      }
      return { t: 'name', n: t.v };
    }
    if (t.k === 'op' && t.v === '(') {
      const e = expr(0);
      expect(')');
      return implicit(e);
    }
    if (t.k === 'op' && (t.v === '-' || t.v === '+' || t.v === '!')) return { t: 'un', op: t.v, a: expr(7) };
    return err(t.k === 'end' ? 'expression ends too early' : `unexpected "${(t as { v: string }).v}"`);
  }

  /** implicit multiplication: 2x, 2(x+1), (a)(b), (a)x */
  function implicit(left: Ast): Ast {
    const t = peek();
    if (t.k === 'id' || (t.k === 'op' && t.v === '(')) {
      const right = primaryPow();
      return { t: 'bin', op: '*', a: left, b: right };
    }
    return left;
  }

  function primaryPow(): Ast {
    let a = primary();
    if (isOp('^')) {
      next();
      a = { t: 'bin', op: '^', a, b: expr(8) };
    }
    return a;
  }

  function expr(minPrec: number): Ast {
    let left = primary();
    for (;;) {
      const t = peek();
      if (t.k !== 'op') break;
      if (t.v === '?' && minPrec === 0) {
        next();
        const a = expr(0);
        expect(':');
        const b = expr(0);
        left = { t: 'cond', c: left, a, b };
        continue;
      }
      const info = BIN[t.v];
      if (!info || info[0] < minPrec) break;
      next();
      const right = expr(info[1] === 'l' ? info[0] + 1 : info[0]);
      left = { t: 'bin', op: t.v, a: left, b: right };
    }
    return left;
  }

  const ast = expr(0);
  if (peek().k !== 'end') err(`unexpected "${(peek() as { v: string }).v}" after the expression`);
  return ast;
}

// ------------------------------------------------------------------ builtins

export const CONSTANTS: Record<string, number> = { pi: Math.PI, π: Math.PI, e: Math.E, tau: 2 * Math.PI, τ: 2 * Math.PI, inf: Infinity };

const FN: Record<string, (...a: number[]) => number> = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan, atan2: Math.atan2,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh, sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs, exp: Math.exp,
  ln: Math.log, log10: Math.log10, log2: Math.log2, floor: Math.floor, ceil: Math.ceil, round: Math.round, sign: Math.sign,
  log: (x, b) => (b === undefined ? Math.log10(x) : Math.log(x) / Math.log(b)),
  pow: Math.pow, hypot: Math.hypot, min: Math.min, max: Math.max,
  clamp: (x, a, b) => Math.min(b, Math.max(a, x)),
  mod: (a, b) => ((a % b) + b) % b,
  deg: (x) => (x * 180) / Math.PI,
  rad: (x) => (x * Math.PI) / 180,
  fact: (n) => factorial(n),
  factorial: (n) => factorial(n),
  choose: (n, k) => factorial(n) / (factorial(k) * factorial(n - k)),
  step: (x) => (x >= 0 ? 1 : 0),
};

function factorial(n: number): number {
  if (n < 0 || !Number.isInteger(n)) return NaN;
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}

/** random functions draw from the evaluation's seeded generator */
const RANDOM = ['rand', 'randn', 'randint', 'coin', 'randexp'];
/** lazy builtins bind their first argument as a local variable (or repeat their body) */
const LAZY = ['sum', 'prod', 'maxover', 'minover', 'argmax', 'argmin', 'integrate', 'meanof', 'sumof', 'if'];

export const BUILTINS = new Set([...Object.keys(FN), ...RANDOM, ...LAZY, 'diff']);

export const LANGUAGE_DOC = `Expressions: + - * / ^ (power) %, comparisons and && || !, "c ? a : b", implicit multiplication (2x). Constants: pi, e. Functions: sin cos tan asin acos atan atan2 sinh cosh tanh sqrt abs exp ln log log10 min max floor ceil round sign hypot clamp mod deg rad choose fact step. Random (seeded, for trials): rand() randn() randint(a,b) coin(p) randexp(rate). Binding forms: sum(k, a, b, expr), prod(k, a, b, expr), integrate(x, a, b, expr), diff(x, at, expr), maxover(x, a, b, expr), minover(...), argmax(...), argmin(...), meanof(n, expr) and sumof(n, expr) (repeat a random expr n times), if(c, a, b). Angles are radians: use rad(degrees).`;

// ------------------------------------------------------------------ evaluation

export interface EvalContext {
  /** value of a free name (a variable, another formula, a system output); undefined if unknown */
  resolve(name: string, bound: Record<string, number>): number | undefined;
  rng?: () => number;
}

let budget = 0;

export function evaluate(ast: Ast, ctx: EvalContext, bound: Record<string, number> = {}): number {
  budget = 10_000_000;
  return ev(ast, ctx, bound);
}

function ev(a: Ast, ctx: EvalContext, bound: Record<string, number>): number {
  if (--budget < 0) err('too much computation (simplify the expression or use fewer terms)');
  switch (a.t) {
    case 'num':
      return a.v;
    case 'name': {
      if (a.n in bound) return bound[a.n];
      if (a.n in CONSTANTS) return CONSTANTS[a.n];
      const v = ctx.resolve(a.n, bound);
      if (v === undefined) return err(`unknown name "${a.n}"`);
      return v;
    }
    case 'un': {
      const x = ev(a.a, ctx, bound);
      return a.op === '-' ? -x : a.op === '!' ? (x ? 0 : 1) : x;
    }
    case 'cond':
      return ev(a.c, ctx, bound) ? ev(a.a, ctx, bound) : ev(a.b, ctx, bound);
    case 'bin': {
      if (a.op === '&&') return ev(a.a, ctx, bound) && ev(a.b, ctx, bound) ? 1 : 0;
      if (a.op === '||') return ev(a.a, ctx, bound) || ev(a.b, ctx, bound) ? 1 : 0;
      const x = ev(a.a, ctx, bound);
      const y = ev(a.b, ctx, bound);
      switch (a.op) {
        case '+': return x + y;
        case '-': return x - y;
        case '*': return x * y;
        case '/': return x / y;
        case '%': return x % y;
        case '^': return Math.pow(x, y);
        case '<': return x < y ? 1 : 0;
        case '>': return x > y ? 1 : 0;
        case '<=': return x <= y ? 1 : 0;
        case '>=': return x >= y ? 1 : 0;
        case '==': return Math.abs(x - y) < 1e-12 ? 1 : 0;
        case '!=': return Math.abs(x - y) >= 1e-12 ? 1 : 0;
      }
      return err(`unknown operator ${a.op}`);
    }
    case 'call':
      return call(a, ctx, bound);
  }
}

function boundName(a: Ast | undefined, f: string): string {
  if (!a || a.t !== 'name') return err(`${f}: the first argument must be a variable name, e.g. ${f}(k, 1, 10, k^2)`);
  return a.n;
}

function rng(ctx: EvalContext): () => number {
  return ctx.rng ?? err('random functions need a random-trials object (they are seeded there)');
}

function call(a: Extract<Ast, { t: 'call' }>, ctx: EvalContext, bound: Record<string, number>): number {
  const { f, args } = a;
  const n = args.length;
  const arity = (lo: number, hi = lo) => (n < lo || n > hi ? err(`${f} takes ${lo === hi ? lo : `${lo}–${hi}`} arguments`) : 0);
  const E = (i: number, b = bound) => ev(args[i], ctx, b);
  switch (f) {
    case 'if':
      arity(3);
      return E(0) ? E(1) : E(2);
    case 'sum':
    case 'prod': {
      arity(4);
      const k = boundName(args[0], f);
      const lo = Math.ceil(E(1));
      const hi = Math.floor(E(2));
      if (hi - lo > 100000) err(`${f}: at most 100000 terms`);
      let acc = f === 'sum' ? 0 : 1;
      for (let i = lo; i <= hi; i++) {
        const v = E(3, { ...bound, [k]: i });
        acc = f === 'sum' ? acc + v : acc * v;
      }
      return acc;
    }
    case 'maxover':
    case 'minover':
    case 'argmax':
    case 'argmin': {
      arity(4, 5);
      const x = boundName(args[0], f);
      const lo = E(1);
      const hi = E(2);
      const N = n === 5 ? Math.min(20000, Math.max(2, Math.round(E(4)))) : 1000;
      let best = f === 'maxover' || f === 'argmax' ? -Infinity : Infinity;
      let arg = lo;
      for (let i = 0; i <= N; i++) {
        const xi = lo + ((hi - lo) * i) / N;
        const v = E(3, { ...bound, [x]: xi });
        if (f === 'maxover' || f === 'argmax' ? v > best : v < best) (best = v), (arg = xi);
      }
      return f === 'argmax' || f === 'argmin' ? arg : best;
    }
    case 'integrate': {
      arity(4);
      const x = boundName(args[0], f);
      const lo = E(1);
      const hi = E(2);
      const N = 400; // Simpson
      const h = (hi - lo) / N;
      let s = 0;
      for (let i = 0; i <= N; i++) s += (i === 0 || i === N ? 1 : i % 2 ? 4 : 2) * E(3, { ...bound, [x]: lo + i * h });
      return (s * h) / 3;
    }
    case 'diff': {
      arity(3);
      const x = boundName(args[0], f);
      const at = E(1);
      const h = 1e-5 * Math.max(1, Math.abs(at));
      return (E(2, { ...bound, [x]: at + h }) - E(2, { ...bound, [x]: at - h })) / (2 * h);
    }
    case 'meanof':
    case 'sumof': {
      arity(2);
      const times = Math.round(E(0));
      if (times < 1 || times > 100000) err(`${f}: the count must be between 1 and 100000`);
      let s = 0;
      for (let i = 0; i < times; i++) s += E(1);
      return f === 'meanof' ? s / times : s;
    }
    case 'rand':
      arity(0);
      return rng(ctx)();
    case 'randn': {
      arity(0);
      const r = rng(ctx);
      return Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
    }
    case 'randint': {
      arity(2);
      const lo = Math.ceil(E(0));
      const hi = Math.floor(E(1));
      return lo + Math.floor(rng(ctx)() * (hi - lo + 1));
    }
    case 'coin':
      arity(0, 1);
      return rng(ctx)() < (n ? E(0) : 0.5) ? 1 : 0;
    case 'randexp':
      arity(0, 1);
      return -Math.log(1 - rng(ctx)()) / (n ? E(0) : 1);
  }
  const fn = FN[f];
  if (!fn) return err(`unknown function "${f}"`);
  return fn(...args.map((_, i) => E(i)));
}

// ------------------------------------------------------------------ analysis

/** free names an expression depends on (excluding constants, builtins, bound variables) */
export function freeNames(ast: Ast, bound: Set<string> = new Set()): Set<string> {
  const out = new Set<string>();
  const walk = (a: Ast, b: Set<string>) => {
    switch (a.t) {
      case 'name':
        if (!b.has(a.n) && !(a.n in CONSTANTS)) out.add(a.n);
        return;
      case 'un':
        return walk(a.a, b);
      case 'bin':
        walk(a.a, b);
        return walk(a.b, b);
      case 'cond':
        walk(a.c, b), walk(a.a, b);
        return walk(a.b, b);
      case 'call': {
        const binds = ['sum', 'prod', 'maxover', 'minover', 'argmax', 'argmin', 'integrate', 'diff'].includes(a.f) && a.args[0]?.t === 'name';
        if (binds) {
          // the body is bound; the range/point arguments are not
          const inner = new Set(b).add((a.args[0] as { n: string }).n);
          const body = a.f === 'diff' ? 2 : 3;
          a.args.forEach((x, i) => i > 0 && walk(x, i === body ? inner : b));
        } else a.args.forEach((x) => walk(x, b));
        return;
      }
    }
  };
  walk(ast, bound);
  return out;
}

export function usesRandom(ast: Ast): boolean {
  if (ast.t === 'call' && RANDOM.includes(ast.f)) return true;
  const kids = ast.t === 'un' ? [ast.a] : ast.t === 'bin' ? [ast.a, ast.b] : ast.t === 'cond' ? [ast.c, ast.a, ast.b] : ast.t === 'call' ? ast.args : [];
  return kids.some(usesRandom);
}

/** check an expression: syntax, known functions, arities of binding forms */
export function check(src: string): { ast: Ast; names: string[] } {
  const ast = parse(src);
  const walk = (a: Ast) => {
    if (a.t === 'call') {
      if (!BUILTINS.has(a.f)) err(`unknown function "${a.f}"`);
      a.args.forEach(walk);
    } else if (a.t === 'un') walk(a.a);
    else if (a.t === 'bin') walk(a.a), walk(a.b);
    else if (a.t === 'cond') walk(a.c), walk(a.a), walk(a.b);
  };
  walk(ast);
  return { ast, names: [...freeNames(ast)] };
}

// ------------------------------------------------------------------ typesetting

const GREEK = new Set(['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'rho', 'sigma', 'tau', 'upsilon', 'phi', 'chi', 'psi', 'omega', 'Gamma', 'Delta', 'Theta', 'Lambda', 'Xi', 'Pi', 'Sigma', 'Phi', 'Psi', 'Omega']);
const FN_TEX: Record<string, string> = { sin: '\\sin', cos: '\\cos', tan: '\\tan', sinh: '\\sinh', cosh: '\\cosh', tanh: '\\tanh', ln: '\\ln', log: '\\log', exp: '\\exp', min: '\\min', max: '\\max', asin: '\\arcsin', acos: '\\arccos', atan: '\\arctan' };

export function nameTex(n: string): string {
  if (n === 'pi' || n === 'π') return '\\pi';
  const [whole, ...rest] = n.split('_');
  // v0 → v₀, x12 → x₁₂: trailing digits read as a subscript
  const m = /^([^\d]+)(\d+)$/.exec(whole);
  const head = m && !rest.length ? m[1] : whole;
  if (m && !rest.length) rest.push(m[2]);
  const base = GREEK.has(head) ? `\\${head}` : head.length === 1 ? head : `\\mathrm{${head}}`;
  return rest.length ? `${base}_{${/^\d+$/.test(rest.join('')) ? rest.join('') : `\\mathrm{${rest.join('\\_')}}`}}` : base;
}

function prec(a: Ast): number {
  if (a.t === 'bin') return BIN[a.op]?.[0] ?? 9;
  if (a.t === 'cond') return 0;
  if (a.t === 'un') return 7;
  return 10;
}

export function toLatex(a: Ast): string {
  const wrap = (x: Ast, p: number) => (prec(x) < p ? `\\left(${toLatex(x)}\\right)` : toLatex(x));
  switch (a.t) {
    case 'num':
      return Number.isInteger(a.v) ? String(a.v) : String(+a.v.toPrecision(6));
    case 'name':
      return nameTex(a.n);
    case 'un':
      return a.op === '!' ? `\\neg ${wrap(a.a, 7)}` : `${a.op}${wrap(a.a, 7)}`;
    case 'cond':
      return `\\begin{cases} ${toLatex(a.a)} & ${toLatex(a.c)} \\\\ ${toLatex(a.b)} & \\text{otherwise} \\end{cases}`;
    case 'bin': {
      const p = prec(a);
      switch (a.op) {
        case '/':
          return `\\frac{${toLatex(a.a)}}{${toLatex(a.b)}}`;
        case '^':
          return `{${wrap(a.a, 9)}}^{${toLatex(a.b)}}`;
        case '*': {
          const tight = (a.a.t === 'num' && (a.b.t === 'name' || a.b.t === 'call')) || (a.a.t === 'name' && a.b.t === 'call' && !!FN_TEX[a.b.f]);
          return `${wrap(a.a, p)}${tight ? '\\,' : ' \\cdot '}${wrap(a.b, p + 1)}`;
        }
        case '-':
          return `${wrap(a.a, p)} - ${wrap(a.b, p + 1)}`;
        default: {
          const op = { '<=': '\\le', '>=': '\\ge', '!=': '\\ne', '==': '=', '&&': '\\land', '||': '\\lor', '%': '\\bmod' }[a.op] ?? a.op;
          return `${wrap(a.a, p)} ${op} ${wrap(a.b, p + 1)}`;
        }
      }
    }
    case 'call': {
      const A = a.args.map(toLatex);
      switch (a.f) {
        case 'sqrt':
          return `\\sqrt{${A[0]}}`;
        case 'abs':
          return `\\left|${A[0]}\\right|`;
        case 'sum':
          return `\\sum_{${A[0]}=${A[1]}}^{${A[2]}} ${wrap(a.args[3], 6)}`;
        case 'prod':
          return `\\prod_{${A[0]}=${A[1]}}^{${A[2]}} ${wrap(a.args[3], 6)}`;
        case 'integrate':
          return `\\int_{${A[1]}}^{${A[2]}} ${wrap(a.args[3], 6)}\\,d${A[0]}`;
        case 'diff':
          return `\\left.\\frac{d}{d${A[0]}}${wrap(a.args[2], 6)}\\right|_{${A[0]}=${A[1]}}`;
        case 'maxover':
          return `\\max_{${A[0]}\\in[${A[1]},${A[2]}]} ${wrap(a.args[3], 6)}`;
        case 'minover':
          return `\\min_{${A[0]}\\in[${A[1]},${A[2]}]} ${wrap(a.args[3], 6)}`;
        case 'meanof':
          return `\\overline{${A[1]}}_{\\,${A[0]}}`;
        case 'rad':
          return `${wrap(a.args[0], 9)}^{\\circ}`;
        case 'choose':
          return `\\binom{${A[0]}}{${A[1]}}`;
        case 'fact':
        case 'factorial':
          return `${wrap(a.args[0], 9)}!`;
        case 'if':
          return `\\begin{cases} ${A[1]} & ${A[0]} \\\\ ${A[2]} & \\text{otherwise} \\end{cases}`;
        default: {
          const fn = FN_TEX[a.f] ?? `\\operatorname{${a.f}}`;
          const single = a.args.length === 1 && (a.args[0].t === 'name' || a.args[0].t === 'num') && FN_TEX[a.f];
          return single ? `${fn} ${A[0]}` : `${fn}\\left(${A.join(', ')}\\right)`;
        }
      }
    }
  }
}

/** a mulberry32 generator for seeded trials */
export function seeded(seed: number): () => number {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
