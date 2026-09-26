import { useState } from 'react';
import { useUI } from './context';
import { INK_SWATCHES } from './Ink';
import { ink } from '../kernel';
import { DEFAULT_MODEL } from '../agent/claude';
import { COMPATIBLE_PRESETS, DEFAULT_OPENAI_MODEL } from '../agent/openai';

export type Provider = 'anthropic' | 'openai' | 'compatible';

export interface AgentSettings {
  provider: 'offline' | Provider;
  /** per provider: use the dev server's key (proxy) or one pasted here */
  access: Record<Provider, 'proxy' | 'key'>;
  keys: Record<Provider, string>;
  models: Record<Provider, string>;
  /** the OpenAI-compatible server (Groq, Ollama, OpenRouter, …) */
  compat: { preset: string; baseURL: string; api: 'chat' | 'responses' };
}

declare const __PROXIES__: Record<Provider, boolean>;
declare const __COMPAT_BASE__: string;
declare const __COMPAT_MODEL__: string;
export const PROXIES: Record<Provider, boolean> = { anthropic: false, openai: false, compatible: false, ...(typeof __PROXIES__ !== 'undefined' ? __PROXIES__ : {}) };
const COMPAT_BASE = typeof __COMPAT_BASE__ !== 'undefined' ? __COMPAT_BASE__ : '';
const COMPAT_MODEL = typeof __COMPAT_MODEL__ !== 'undefined' ? __COMPAT_MODEL__ : '';

export function defaultSettings(): AgentSettings {
  const preset = COMPATIBLE_PRESETS.find((p) => p.baseURL === COMPAT_BASE) ?? COMPATIBLE_PRESETS[0];
  return {
    provider: PROXIES.anthropic ? 'anthropic' : PROXIES.openai ? 'openai' : PROXIES.compatible ? 'compatible' : 'offline',
    access: { anthropic: PROXIES.anthropic ? 'proxy' : 'key', openai: PROXIES.openai ? 'proxy' : 'key', compatible: PROXIES.compatible ? 'proxy' : 'key' },
    keys: { anthropic: '', openai: '', compatible: '' },
    models: { anthropic: DEFAULT_MODEL, openai: DEFAULT_OPENAI_MODEL, compatible: COMPAT_MODEL || preset.model },
    compat: { preset: COMPAT_BASE && !COMPATIBLE_PRESETS.some((p) => p.baseURL === COMPAT_BASE) ? 'custom' : preset.id, baseURL: COMPAT_BASE || preset.baseURL, api: 'chat' },
  };
}

const PROVIDERS: { id: Provider; name: string; env: string; host: string; placeholder: string; fallback: string }[] = [
  { id: 'anthropic', name: 'Claude', env: 'ANTHROPIC_API_KEY', host: 'api.anthropic.com', placeholder: 'sk-ant-…', fallback: DEFAULT_MODEL },
  { id: 'openai', name: 'OpenAI', env: 'OPENAI_API_KEY', host: 'api.openai.com', placeholder: 'sk-…', fallback: DEFAULT_OPENAI_MODEL },
  { id: 'compatible', name: 'OpenAI-compatible (Groq, Ollama, OpenRouter, …)', env: 'OPENAI_COMPAT_BASE_URL', host: 'that server', placeholder: 'API key (blank for local servers)', fallback: COMPATIBLE_PRESETS[0].model },
];

function CompatFields({ settings, setSettings }: { settings: AgentSettings; setSettings: (s: AgentSettings) => void }) {
  const c = settings.compat;
  const stop = (e: React.KeyboardEvent) => e.stopPropagation();
  const proxied = settings.access.compatible === 'proxy' && PROXIES.compatible;
  const preset = COMPATIBLE_PRESETS.find((p) => p.id === c.preset);
  return (
    <>
      <h4 style={{ marginTop: 8 }}>Server</h4>
      {proxied ? (
        <div className="small muted" style={{ padding: '0 4px 6px' }}>dev server proxies to {COMPAT_BASE}</div>
      ) : (
        <>
          <select
            className="inline"
            style={{ width: '100%', marginBottom: 4 }}
            value={c.preset}
            onChange={(e) => {
              const p = COMPATIBLE_PRESETS.find((x) => x.id === e.target.value);
              setSettings({ ...settings, compat: { ...c, preset: e.target.value, baseURL: p?.baseURL ?? c.baseURL }, models: { ...settings.models, compatible: p?.model ?? settings.models.compatible } });
            }}
          >
            {COMPATIBLE_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            <option value="custom">Other…</option>
          </select>
          <input type="text" placeholder="base URL, e.g. https://api.groq.com/openai/v1" value={c.baseURL} onChange={(e) => setSettings({ ...settings, compat: { ...c, preset: 'custom', baseURL: e.target.value } })} onKeyDown={stop} />
          {preset?.note && <div className="small muted">{preset.note}</div>}
        </>
      )}
      <label className="item small">
        <input type="checkbox" checked={c.api === 'responses'} onChange={(e) => setSettings({ ...settings, compat: { ...c, api: e.target.checked ? 'responses' : 'chat' } })} /> server speaks the Responses API (default: Chat Completions)
      </label>
    </>
  );
}

type Pop = null | 'branches' | 'glyphs' | 'add' | 'settings';

export function TopBar({
  settings,
  setSettings,
  onDiff,
  onReset,
}: {
  settings: AgentSettings;
  setSettings: (s: AgentSettings) => void;
  onDiff: (a: string, b: string) => void;
  onReset: () => void;
}) {
  const ui = useUI();
  const k = ui.kernel;
  const [pop, setPop] = useState<Pop>(null);
  const [forkName, setForkName] = useState('');
  const [forkWhy, setForkWhy] = useState('');
  const toggle = (p: Pop) => setPop(pop === p ? null : p);
  const glyphs = Object.values(ui.ws.glyphs);

  const depth = (id: string): number => (k.branches[id].parent ? 1 + depth(k.branches[id].parent!) : 0);
  const ordered = Object.values(k.branches).sort((a, b) => a.createdAt - b.createdAt);

  const create = (kind: string, params?: Record<string, unknown>) => {
    const c = ui.viewportCenter();
    ui.act([{ op: 'create_object', kind, ...(params ? { params } : {}), placement: { at: { x: Math.round(c.x - 140), y: Math.round(c.y - 100) } } }]);
    setPop(null);
  };

  return (
    <div className="topbar" onPointerDown={(e) => e.stopPropagation()}>
      <span className="brand">Thought<i>Space</i></span>

      <div className="tb-group anchor">
        <button className="tb-btn" onClick={() => toggle('branches')} title="workspace branches">⑂ {k.branch.name}</button>
        {pop === 'branches' && (
          <div className="pop" style={{ left: 0, width: 300 }}>
            <h4>Branches</h4>
            {ordered.map((b) => (
              <div key={b.id} className={`item ${b.id === k.current ? 'cur' : ''}`} style={{ paddingLeft: 6 + depth(b.id) * 14 }}>
                <span style={{ flex: 1 }} onClick={() => { k.switchBranch(b.id); setPop(null); }}>
                  {depth(b.id) > 0 ? '└ ' : ''}{b.name}
                  {b.assumption && <div className="small" style={{ color: 'var(--ai)' }}>{b.assumption}</div>}
                  <div className="small muted">{b.cursor} steps{b.parent ? ` · forked from ${k.branches[b.parent].name}` : ''}</div>
                </span>
                {b.id !== k.current && (
                  <button className="btn icon" title="compare with current" onClick={() => { onDiff(k.current, b.id); setPop(null); }}>⇄</button>
                )}
              </div>
            ))}
            <h4 style={{ marginTop: 10 }}>Fork this workspace</h4>
            <input type="text" placeholder="name, e.g. relu-world" value={forkName} onChange={(e) => setForkName(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
            <input type="text" placeholder="assumption, e.g. what if activations were ReLU?" value={forkWhy} onChange={(e) => setForkWhy(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
            <button
              className="btn primary"
              onClick={() => {
                k.fork(forkName || `branch ${Object.keys(k.branches).length}`, forkWhy || undefined, 'human');
                setForkName('');
                setForkWhy('');
                setPop(null);
              }}
            >
              Fork
            </button>
            <h4 style={{ marginTop: 10 }}>This branch's history</h4>
            <div className="hist" style={{ maxHeight: 180, overflow: 'auto' }}>
              {k.lineage().slice(-30).reverse().map(({ tx, branch }) => (
                <div key={tx.id}>
                  <span className="t">{new Date(tx.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                  <span>{tx.actor === 'ai' ? '✦' : '●'}</span>
                  <span style={{ flex: 1 }}>{tx.summary}</span>
                  {branch !== k.current && <span className="muted">{k.branches[branch].name}</span>}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="tb-group">
        <button className="tb-btn" disabled={!k.canUndo()} onClick={() => k.undo()} title="undo (⌘Z)">↶</button>
        <button className="tb-btn" disabled={!k.canRedo()} onClick={() => k.redo()} title="redo (⇧⌘Z)">↷</button>
      </div>

      <div className="tb-group anchor">
        <button className="tb-btn" onClick={() => toggle('add')}>+ Object</button>
        {pop === 'add' && (
          <div className="pop" style={{ left: 0 }}>
            <div className="item" onClick={() => create('text')}>Note</div>
            <div className="item" onClick={() => create('dataset', { preset: 'xor' })}>Dataset</div>
            <div className="item" onClick={() => create('neural_network')}>Neural network</div>
            <div className="item" onClick={() => create('function')}>Function</div>
            <div className="item" onClick={() => create('equation')}>Equation</div>
            <div className="item" onClick={() => create('graph')}>Graph (connect a source)</div>
          </div>
        )}
        <button className="tb-btn" onClick={() => toggle('glyphs')}>◆ Glyphs {glyphs.length ? `(${glyphs.length})` : ''}</button>
        {pop === 'glyphs' && (
          <div className="pop" style={{ left: 60 }}>
            <h4>Glyph library</h4>
            {glyphs.length === 0 && <div className="small muted" style={{ padding: 6 }}>Select a construction and ask to “turn this into a reusable glyph”.</div>}
            {glyphs.map((g) => (
              <div
                key={g.id}
                className="item"
                onClick={() => {
                  const c = ui.viewportCenter();
                  ui.act([{ op: 'instantiate_glyph', definition: g.id, placement: { at: { x: Math.round(c.x - 130), y: Math.round(c.y - 120) } } }]);
                  setPop(null);
                }}
              >
                <span>◆ <b>{g.name}</b><div className="small muted">{g.description}</div><div className="small muted">exposes {g.exposed.map((e) => e.name).join(', ') || 'nothing'}</div></span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="tb-group">
        <button className={`tb-btn ${ui.tool === 'pen' ? 'on' : ''}`} onClick={() => ui.setTool(ui.tool === 'pen' ? 'select' : 'pen')} title="draw on the paper (P)">✎ Draw</button>
        {ui.tool === 'pen' && (
          <>
            {INK_SWATCHES.map((s, i) => (
              <button key={s.color} className={`swatch ${ui.pen === s.color ? 'on' : ''}`} style={{ background: ink.INK_HEX[s.color] }} title={`${s.title} (${i + 1})`} onClick={() => ui.setPen(s.color)} />
            ))}
            <span className="pen-hint">dot on data = point · line across a neuron's plot = its boundary · loop = select</span>
          </>
        )}
      </div>

      <span className="spacer" />

      <div className="tb-group anchor">
        <button className={`tb-btn ${settings.provider !== 'offline' ? 'on' : ''}`} onClick={() => toggle('settings')} title="agent settings">
          {settings.provider === 'offline' ? '◇ offline planner' : `✦ ${settings.models[settings.provider]}`} ⚙
        </button>
        {pop === 'settings' && (
          <div className="pop" style={{ right: 0, width: 320 }}>
            <h4>AI participant</h4>
            <label className="item"><input type="radio" checked={settings.provider === 'offline'} onChange={() => setSettings({ ...settings, provider: 'offline' })} /> Offline planner (deterministic, no network)</label>
            {PROVIDERS.map((pv) => (
              <label key={pv.id} className="item"><input type="radio" checked={settings.provider === pv.id} onChange={() => setSettings({ ...settings, provider: pv.id })} /> {pv.name}</label>
            ))}
            {PROVIDERS.filter((pv) => pv.id === settings.provider).map((pv) => (
              <div key={pv.id} style={{ padding: '2px 6px' }}>
                <label className="item" style={{ opacity: PROXIES[pv.id] ? 1 : 0.5 }}>
                  <input type="radio" disabled={!PROXIES[pv.id]} checked={settings.access[pv.id] === 'proxy'} onChange={() => setSettings({ ...settings, access: { ...settings.access, [pv.id]: 'proxy' } })} /> key from the dev server {PROXIES[pv.id] ? '' : `(set ${pv.env})`}
                </label>
                <label className="item">
                  <input type="radio" checked={settings.access[pv.id] === 'key'} onChange={() => setSettings({ ...settings, access: { ...settings.access, [pv.id]: 'key' } })} /> my own key
                </label>
                {settings.access[pv.id] === 'key' && (
                  <>
                    <input type="password" placeholder={pv.placeholder} value={settings.keys[pv.id]} onChange={(e) => setSettings({ ...settings, keys: { ...settings.keys, [pv.id]: e.target.value } })} onKeyDown={(e) => e.stopPropagation()} />
                    <div className="small muted">Stored in this browser only and sent directly to {pv.host}.</div>
                  </>
                )}
                {pv.id === 'compatible' && <CompatFields settings={settings} setSettings={setSettings} />}
                <h4 style={{ marginTop: 8 }}>Model</h4>
                <input type="text" value={settings.models[pv.id]} onChange={(e) => setSettings({ ...settings, models: { ...settings.models, [pv.id]: e.target.value || pv.fallback } })} onKeyDown={(e) => e.stopPropagation()} />
              </div>
            ))}
            <h4 style={{ marginTop: 8 }}>Workspace</h4>
            <div className="actions">
              <button
                className="btn"
                onClick={() => {
                  const blob = new Blob([k.serialize()], { type: 'application/json' });
                  const a = document.createElement('a');
                  a.href = URL.createObjectURL(blob);
                  a.download = 'thoughtspace.json';
                  a.click();
                }}
              >
                Export history
              </button>
              <button className="btn" onClick={() => { onReset(); setPop(null); }}>Clear workspace</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
