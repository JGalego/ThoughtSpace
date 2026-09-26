import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Kernel, type BranchDiff, type ObjectId, type Operation, type ink } from '../kernel';
import { localAgent } from '../agent/local';
import { claudeAgent } from '../agent/claude';
import { COMPATIBLE_PRESETS, openaiAgent } from '../agent/openai';
import type { AgentHost } from '../agent/host';
import { UICtx, useKernelVersion, type Detail, type UI } from './context';
import { Canvas, type View } from './Canvas';
import { Inspector, BranchDiffPanel } from './Inspector';
import { TopBar, PROXIES, defaultSettings, type AgentSettings } from './TopBar';
import { CommandBar, type Msg } from './CommandBar';

const STORE = 'thoughtspace.workspace.v1';
const LOG = 'thoughtspace.log.v1';
const SETTINGS = 'thoughtspace.settings.v2';
const DISMISSED = 'thoughtspace.dismissed.v1';

const kernel = new Kernel();
// a handle for scripted demos and debugging in the browser console
if (import.meta.env.DEV) (window as unknown as { thoughtspace: Kernel }).thoughtspace = kernel;
kernel.load(localStorage.getItem(STORE) ?? '');

function readJSON<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}

const EXAMPLES = ["Let's understand why XOR requires a hidden layer."];

export function App() {
  const version = useKernelVersion(kernel);
  const ws = kernel.state();
  const [selection, setSelection] = useState<ObjectId[]>([]);
  const [view, setView] = useState<View>({ x: 40, y: 50, s: 1 });
  const [highlights, setHighlights] = useState<Set<string>>(new Set());
  const [probe, setProbe] = useState<[number, number] | null>(null);
  const [log, setLog] = useState<Msg[]>(() => readJSON(LOG, []));
  const [busy, setBusy] = useState<string | null>(null);
  const [settings, setSettingsState] = useState<AgentSettings>(() => {
    const d = defaultSettings();
    const s = readJSON<Partial<AgentSettings>>(SETTINGS, {});
    return { ...d, ...s, access: { ...d.access, ...s.access }, keys: { ...d.keys, ...s.keys }, models: { ...d.models, ...s.models }, compat: { ...d.compat, ...s.compat } };
  });
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set(readJSON<string[]>(DISMISSED, [])));
  const [diff, setDiff] = useState<BranchDiff | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [tool, setTool] = useState<'select' | 'pen'>('select');
  const [pen, setPen] = useState<ink.InkColor>('ink');
  const hiTimer = useRef<number | undefined>(undefined);
  // the inspector waits until the pointer is released so it never lands on what you're clicking
  const [pointerDown, setPointerDown] = useState(false);
  useEffect(() => {
    const down = () => setPointerDown(true);
    const up = () => setPointerDown(false);
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('pointerup', up, true);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointerup', up, true);
    };
  }, []);
  const showInspector = selection.length > 0 && inspectorOpen && !pointerDown;
  useEffect(() => {
    if (!showInspector || selection.length !== 1) return;
    const o = kernel.state().objects[selection[0]];
    if (!o) return;
    const limit = window.innerWidth - 340;
    setView((v) => {
      const right = v.x + (o.visual.x + o.visual.w) * v.s;
      const left = v.x + o.visual.x * v.s;
      if (right <= limit) return v;
      const shift = Math.min(right - limit + 16, Math.max(0, left - 16));
      return shift > 0 ? { ...v, x: v.x - shift } : v;
    });
  }, [showInspector, selection]);

  // persistence (debounced)
  useEffect(() => {
    const t = window.setTimeout(() => localStorage.setItem(STORE, kernel.serialize()), 400);
    return () => window.clearTimeout(t);
  }, [version]);
  useEffect(() => localStorage.setItem(LOG, JSON.stringify(log.slice(-80))), [log]);
  useEffect(() => {
    if (diff) setDiff(kernel.diffBranches(diff.a, diff.b));
  }, [version]); // eslint-disable-line react-hooks/exhaustive-deps

  // selection only holds existing, visible objects
  useEffect(() => {
    setSelection((s) => {
      const f = s.filter((id) => ws.objects[id] && !ws.objects[id].visual.hidden);
      return f.length === s.length ? s : f;
    });
  }, [ws]);

  const setSettings = (s: AgentSettings) => {
    setSettingsState(s);
    localStorage.setItem(SETTINGS, JSON.stringify(s));
  };

  const agent = useMemo(() => {
    const p = settings.provider;
    if (p === 'offline') return localAgent;
    const model = settings.models[p];
    if (p === 'compatible') {
      const c = settings.compat;
      const label = COMPATIBLE_PRESETS.find((x) => x.id === c.preset)?.name.replace(/ \(local\)$/, '') ?? 'OpenAI-compatible';
      if (settings.access.compatible === 'proxy' && PROXIES.compatible) return openaiAgent({ mode: 'proxy', proxyPath: '/api/compat', model, api: c.api, label, reasoningEffort: c.reasoning || undefined });
      // local servers usually need no key
      if (c.baseURL) return openaiAgent({ mode: 'key', apiKey: settings.keys.compatible, baseURL: c.baseURL, model, api: c.api, label, reasoningEffort: c.reasoning || undefined });
      return localAgent;
    }
    const make = p === 'anthropic' ? claudeAgent : openaiAgent;
    if (settings.access[p] === 'proxy' && PROXIES[p]) return make({ mode: 'proxy', model });
    if (settings.access[p] === 'key' && settings.keys[p]) return make({ mode: 'key', apiKey: settings.keys[p], model });
    return localAgent;
  }, [settings]);

  const detail: Detail = view.s < 0.6 ? 'glance' : view.s > 1.45 ? 'detail' : 'normal';

  const viewportCenter = useCallback(() => ({ x: (window.innerWidth / 2 - view.x) / view.s, y: (window.innerHeight / 2 - view.y) / view.s }), [view]);

  const focus = useCallback((ids: ObjectId[]) => {
    const objs = ids.map((id) => kernel.state().objects[id]).filter((o) => o && !o.visual.hidden);
    if (!objs.length) return;
    const x0 = Math.min(...objs.map((o) => o.visual.x)) - 60;
    const y0 = Math.min(...objs.map((o) => o.visual.y)) - 60;
    const x1 = Math.max(...objs.map((o) => o.visual.x + o.visual.w)) + 60;
    const y1 = Math.max(...objs.map((o) => o.visual.y + o.visual.h)) + 90;
    const W = window.innerWidth - 340, H = window.innerHeight - 240;
    setView((v) => {
      // only move if something is off-screen; keep the user's zoom when possible
      const inView = (v.x + x0 * v.s >= 0) && (v.y + y0 * v.s >= 40) && (v.x + x1 * v.s <= W) && (v.y + y1 * v.s <= H + 50);
      if (inView) return v;
      // never zoom out past the point where objects collapse to glances
      const s = Math.max(0.64, Math.min(1, W / (x1 - x0), H / (y1 - y0)));
      if (s === 0.64) {
        // too big to fit: frame the top-left of the new material instead
        return { s, x: 40 - x0 * s, y: 60 - y0 * s };
      }
      return { s, x: (W - (x1 - x0) * s) / 2 - x0 * s + 10, y: 50 + (H - (y1 - y0) * s) / 2 - y0 * s };
    });
  }, []);

  const highlight = useCallback((targets: string[]) => {
    setHighlights(new Set(targets));
    window.clearTimeout(hiTimer.current);
    hiTimer.current = window.setTimeout(() => setHighlights(new Set()), 5200);
  }, []);

  const ask = useCallback(
    async (text: string, sel?: ObjectId[]) => {
      const selNow = sel ?? selection;
      if (sel) setSelection(sel);
      setLog((l) => [...l, { role: 'user', text }]);
      const applied: string[] = [];
      const host: AgentHost = {
        kernel,
        selection: () => selNow,
        apply: (ops: Operation[], summary?: string, refs?: Record<string, ObjectId>) => {
          const r = kernel.dispatch(ops, 'ai', { summary, refs });
          if (r.ok) {
            applied.push(summary ?? ops.map((o) => o.op).join(', '));
            // follow the AI's hands: whatever it just made comes into view
            const made = r.created.filter((id) => !kernel.state().objects[id]?.visual.hidden);
            if (made.length) focus(made);
          }
          return r;
        },
        highlight,
        focus,
        say: (t) => setLog((l) => [...l, { role: 'ai', text: t, ...(applied.length ? { ops: `✦ ${applied.splice(0).join(' · ')}` } : {}) }]),
        status: setBusy,
      };
      setBusy('thinking…');
      try {
        const history = log.filter((m) => m.role !== 'system').map((m) => ({ role: m.role as 'user' | 'ai', text: m.text }));
        await agent.run(text, host, history);
        if (applied.length) setLog((l) => [...l, { role: 'system', text: `✦ ${applied.join(' · ')}` }]);
      } catch (e) {
        setLog((l) => [...l, { role: 'system', text: `Agent error: ${(e as Error).message}` }]);
      } finally {
        setBusy(null);
      }
    },
    [agent, selection, log, highlight, focus],
  );

  const ui: UI = {
    kernel,
    ws,
    act: (ops, opts) => {
      const r = kernel.dispatch(ops, 'human', opts);
      if (!r.ok && !opts?.coalesceKey) setLog((l) => [...l, { role: 'system', text: r.errors.join('; ') }]);
      return r;
    },
    selection,
    select: (ids, additive) => setSelection((s) => (additive ? [...new Set([...s, ...ids])] : ids)),
    isHighlighted: (id, sub) => (sub ? highlights.has(`${id}#${sub}`) : highlights.has(id)),
    detail,
    probe,
    setProbe,
    ask: (t, s) => void ask(t, s),
    dismissed,
    dismiss: (k) =>
      setDismissed((d) => {
        const n = new Set(d).add(k);
        localStorage.setItem(DISMISSED, JSON.stringify([...n]));
        return n;
      }),
    focus,
    viewportCenter,
    tool,
    setTool,
    pen,
    setPen,
  };

  // keyboard
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) kernel.redo();
        else kernel.undo();
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        kernel.redo();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selection.length) {
        e.preventDefault();
        kernel.dispatch(selection.map((id) => ({ op: 'delete_object', id })), 'human');
      } else if (e.key === 'Escape') {
        setSelection([]);
        setTool('select');
      } else if (!mod && (e.key === 'p' || e.key === 'P')) setTool(tool === 'pen' ? 'select' : 'pen');
      else if (!mod && tool === 'pen' && ['1', '2', '3', '4'].includes(e.key)) setPen((['ink', 'orange', 'blue', 'violet'] as const)[Number(e.key) - 1]);
      else if (mod && e.key.toLowerCase() === 'd' && selection.length === 1) {
        e.preventDefault();
        kernel.dispatch([{ op: 'duplicate', id: selection[0] }], 'human');
      } else if (e.key === '=' || e.key === '+') zoomBy(1.2);
      else if (e.key === '-') zoomBy(1 / 1.2);
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });

  const zoomBy = (f: number) =>
    setView((v) => {
      const s = Math.max(0.25, Math.min(2.5, v.s * f));
      const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
      return { s, x: cx - ((cx - v.x) * s) / v.s, y: cy - ((cy - v.y) * s) / v.s };
    });

  const empty = Object.values(ws.objects).filter((o) => !o.visual.hidden).length === 0;

  return (
    <UICtx.Provider value={ui}>
      <div className="app">
        <Canvas view={view} setView={setView} />
        {empty && (
          <div className="empty-hint">
            <h1>A blank ThoughtSpace.</h1>
            <p>Start with an idea. The AI builds things you can hold, not paragraphs.</p>
            <div className="chips">
              {EXAMPLES.map((x) => (
                <button key={x} className="chip" onClick={() => void ask(x, [])}>{x}</button>
              ))}
            </div>
          </div>
        )}
        <TopBar
          settings={settings}
          setSettings={setSettings}
          onDiff={(a, b) => setDiff(kernel.diffBranches(a, b))}
          onReset={() => {
            kernel.reset();
            setLog([]);
            setSelection([]);
            setDismissed(new Set());
            localStorage.removeItem(DISMISSED);
          }}
        />
        {diff ? <BranchDiffPanel diff={diff} onClose={() => setDiff(null)} /> : showInspector && <Inspector onClose={() => setInspectorOpen(false)} />}
        {!inspectorOpen && selection.length > 0 && (
          <button className="btn" style={{ position: 'absolute', right: 12, top: 52, zIndex: 9 }} onClick={() => setInspectorOpen(true)}>Inspector</button>
        )}
        <div className="zoombar tb-group" onPointerDown={(e) => e.stopPropagation()}>
          <button className="tb-btn" onClick={() => zoomBy(1 / 1.25)} title="zoom out (−) — objects collapse to their essence">−</button>
          <button className="tb-btn" onClick={() => setView({ x: 40, y: 50, s: 1 })} title="reset zoom">{Math.round(view.s * 100)}% · {detail}</button>
          <button className="tb-btn" onClick={() => zoomBy(1.25)} title="zoom in (+) — objects reveal internals">+</button>
          <button className="tb-btn" onClick={() => focus(Object.keys(ws.objects))} title="fit everything">fit</button>
        </div>
        <CommandBar log={log} busy={busy} agentName={agent.name} onSubmit={(t) => void ask(t)} />
      </div>
    </UICtx.Provider>
  );
}
