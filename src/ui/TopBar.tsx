import { useState } from 'react';
import { useUI } from './context';
import { DEFAULT_MODEL } from '../agent/claude';

export interface AgentSettings {
  mode: 'offline' | 'proxy' | 'key';
  apiKey: string;
  model: string;
}

declare const __PROXY_HAS_KEY__: boolean;
export const PROXY_AVAILABLE = typeof __PROXY_HAS_KEY__ !== 'undefined' && __PROXY_HAS_KEY__;

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
        <button className={`tb-btn ${settings.mode !== 'offline' ? 'on' : ''}`} onClick={() => toggle('settings')} title="agent settings">
          {settings.mode === 'offline' ? '◇ offline planner' : `✦ ${settings.model}`} ⚙
        </button>
        {pop === 'settings' && (
          <div className="pop" style={{ right: 0, width: 320 }}>
            <h4>AI participant</h4>
            <label className="item"><input type="radio" checked={settings.mode === 'offline'} onChange={() => setSettings({ ...settings, mode: 'offline' })} /> Offline planner (deterministic, no network)</label>
            <label className="item" style={{ opacity: PROXY_AVAILABLE ? 1 : 0.5 }}>
              <input type="radio" disabled={!PROXY_AVAILABLE} checked={settings.mode === 'proxy'} onChange={() => setSettings({ ...settings, mode: 'proxy' })} /> Claude via dev server {PROXY_AVAILABLE ? '' : '(start with ANTHROPIC_API_KEY set)'}
            </label>
            <label className="item"><input type="radio" checked={settings.mode === 'key'} onChange={() => setSettings({ ...settings, mode: 'key' })} /> Claude with my API key</label>
            {settings.mode === 'key' && (
              <>
                <input type="password" placeholder="sk-ant-…" value={settings.apiKey} onChange={(e) => setSettings({ ...settings, apiKey: e.target.value })} onKeyDown={(e) => e.stopPropagation()} />
                <div className="small muted">Stored in this browser only and sent directly to api.anthropic.com.</div>
              </>
            )}
            {settings.mode !== 'offline' && (
              <>
                <h4 style={{ marginTop: 8 }}>Model</h4>
                <input type="text" value={settings.model} onChange={(e) => setSettings({ ...settings, model: e.target.value || DEFAULT_MODEL })} onKeyDown={(e) => e.stopPropagation()} />
              </>
            )}
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
