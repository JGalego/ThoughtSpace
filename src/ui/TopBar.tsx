import { useState } from 'react';
import { useUI } from './context';
import { DEFAULT_MODEL } from '../agent/claude';
import { DEFAULT_OPENAI_MODEL } from '../agent/openai';

export type Provider = 'anthropic' | 'openai';

export interface AgentSettings {
  provider: 'offline' | Provider;
  /** per provider: use the dev server's key (proxy) or one pasted here */
  access: Record<Provider, 'proxy' | 'key'>;
  keys: Record<Provider, string>;
  models: Record<Provider, string>;
}

declare const __PROXIES__: Record<Provider, boolean>;
export const PROXIES: Record<Provider, boolean> = typeof __PROXIES__ !== 'undefined' ? __PROXIES__ : { anthropic: false, openai: false };

export function defaultSettings(): AgentSettings {
  return {
    provider: PROXIES.anthropic ? 'anthropic' : PROXIES.openai ? 'openai' : 'offline',
    access: { anthropic: PROXIES.anthropic ? 'proxy' : 'key', openai: PROXIES.openai ? 'proxy' : 'key' },
    keys: { anthropic: '', openai: '' },
    models: { anthropic: DEFAULT_MODEL, openai: DEFAULT_OPENAI_MODEL },
  };
}

const PROVIDERS: { id: Provider; name: string; env: string; host: string; placeholder: string; fallback: string }[] = [
  { id: 'anthropic', name: 'Claude', env: 'ANTHROPIC_API_KEY', host: 'api.anthropic.com', placeholder: 'sk-ant-…', fallback: DEFAULT_MODEL },
  { id: 'openai', name: 'OpenAI', env: 'OPENAI_API_KEY', host: 'api.openai.com', placeholder: 'sk-…', fallback: DEFAULT_OPENAI_MODEL },
];

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
