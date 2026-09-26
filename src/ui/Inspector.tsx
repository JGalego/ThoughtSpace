// Inspector: every object's parameters (generated from its kind), provenance, relations,
// event history and the exact semantic view the AI receives.

import { useState } from 'react';
import { kindSpec, networks, semanticView, type BranchDiff, type ExposedParam, type TSObject } from '../kernel';
import { useUI } from './context';
import { ParamControl } from './views';

const fmtTime = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const who = (a: string) => (a === 'ai' ? '✦ AI' : a === 'human' ? '● you' : 'system');

export function Inspector({ onClose }: { onClose: () => void }) {
  const ui = useUI();
  const sel = ui.selection.map((id) => ui.ws.objects[id]).filter(Boolean);
  if (sel.length === 0) return null;
  if (sel.length > 1) return <Multi objs={sel} onClose={onClose} />;
  return <Single o={sel[0]} onClose={onClose} />;
}

function Multi({ objs, onClose }: { objs: TSObject[]; onClose: () => void }) {
  const ui = useUI();
  const ids = objs.map((o) => o.id);
  return (
    <div className="inspector" onPointerDown={(e) => e.stopPropagation()}>
      <button className="close" onClick={onClose}>×</button>
      <h3>{objs.length} objects</h3>
      <div className="small muted" style={{ margin: '4px 0 10px' }}>{objs.map((o) => o.label).join(' · ')}</div>
      <div className="actions">
        {objs.length === 2 && <button className="btn" onClick={() => ui.act([{ op: 'compare', a: ids[0], b: ids[1] }])}>Compare</button>}
        <button className="btn" onClick={() => ui.act([{ op: 'group', ids, label: 'Group' }])}>Group</button>
        <button className="btn ai" onClick={() => ui.ask('Turn this into a reusable glyph.', ids)}>Make glyph…</button>
        <button className="btn" onClick={() => ui.act(ids.map((id) => ({ op: 'delete_object', id })))}>Delete</button>
      </div>
    </div>
  );
}

function Single({ o, onClose }: { o: TSObject; onClose: () => void }) {
  const ui = useUI();
  const [showAI, setShowAI] = useState(false);
  const spec = kindSpec(o.kind)!;
  const p = o.provenance;
  const rels = Object.values(ui.ws.relations).filter((r) => r.from === o.id || r.to === o.id);
  const history = ui.kernel.historyOf(o.id).slice(-14).reverse();
  const link = (id: string) =>
    ui.ws.objects[id] ? (
      <span key={id} className="link" onClick={() => ui.select([id])}>{ui.ws.objects[id].label}</span>
    ) : (
      <span key={id} className="muted">{id} (gone)</span>
    );

  const params =
    o.kind === 'glyph'
      ? (o.state.exposed as ExposedParam[]).map((e) => {
          const inner = ui.ws.objects[e.id];
          return { name: e.name, spec: inner && kindSpec(inner.kind)!.params.find((q) => q.name === e.param), value: inner?.params[e.param] };
        })
      : spec.params.map((s) => ({ name: s.name, spec: s, value: o.params[s.name] }));

  return (
    <div className="inspector" onPointerDown={(e) => e.stopPropagation()}>
      <button className="close" onClick={onClose}>×</button>
      <div className="small muted">{spec.title} · <span className="mono">{o.id}</span></div>
      <h3>{o.label}</h3>

      {params.length > 0 && (
        <>
          <h5>Parameters</h5>
          {params.map(({ name, spec: ps, value }) =>
            ps ? (
              <div className="param" key={name} title={ps.description}>
                <label>{name}</label>
                <ParamControl spec={ps} value={value} onChange={(v) => ui.act([{ op: 'set_parameter', id: o.id, param: name, value: v }])} />
              </div>
            ) : null,
          )}
        </>
      )}

      <h5>Do</h5>
      <div className="actions">
        {o.kind === 'neural_network' && (
          <>
            <button className="btn primary" onClick={() => ui.act([{ op: 'execute', id: o.id }])}>Train</button>
            <button className="btn" onClick={() => ui.act([{ op: 'plot', source: o.id, mode: 'decision_boundary' }])}>Plot boundary</button>
            <button className="btn" onClick={() => ui.act([{ op: 'zoom_into', id: o.id, form: 'network' }])}>Zoom: as function</button>
            <button className="btn" onClick={() => ui.act([{ op: 'zoom_into', id: o.id, form: 'boundary' }])}>Zoom: boundary</button>
            <button className="btn ai" onClick={() => ui.ask('Run an experiment on this.', [o.id])}>Experiment…</button>
            <button className="btn ai" onClick={() => ui.ask("Why doesn't this one work?", [o.id])}>Why?</button>
          </>
        )}
        {o.kind === 'simulation' && <button className="btn" onClick={() => ui.act([{ op: 'plot', source: o.id, mode: 'loss_curve' }])}>Plot loss</button>}
        {o.kind === 'experiment' && <button className="btn" onClick={() => ui.act([{ op: 'reproduce', id: o.id }])}>Reproduce</button>}
        {o.kind === 'glyph' && <button className="btn" onClick={() => ui.act([{ op: 'expand', id: o.id }])}>{o.visual.expanded ? 'Collapse' : 'Expand'}</button>}
        {o.kind === 'claim' && o.state.status === 'unverified' && <button className="btn ai" onClick={() => ui.ask('Run an experiment to test this claim.', [o.id])}>Test it…</button>}
        {!['glyph', 'group', 'comparison', 'experiment', 'claim', 'simulation'].includes(o.kind) && <button className="btn" onClick={() => ui.act([{ op: 'duplicate', id: o.id }])}>Duplicate</button>}
        {o.kind === 'neural_network' && networks(ui.ws).length > 1 && (
          <select className="inline" value="" onChange={(e) => e.target.value && ui.act([{ op: 'compare', a: o.id, b: e.target.value }])}>
            <option value="">Compare with…</option>
            {networks(ui.ws).filter((n) => n.id !== o.id).map((n) => <option key={n.id} value={n.id}>{n.label}</option>)}
          </select>
        )}
        <button className="btn" onClick={() => ui.act([{ op: 'delete_object', id: o.id }])}>Delete</button>
      </div>

      <h5>Provenance</h5>
      <div className="prov-tree">
        <div>{who(p.createdBy)} · {p.operation} · {fmtTime(p.createdAt)}</div>
        {p.assumption && <div style={{ color: 'var(--ai)' }}>assumption: {p.assumption}</div>}
        {p.derivedFrom.length > 0 && <div>derived from {p.derivedFrom.map(link).reduce<React.ReactNode[]>((a, x, i) => (i ? [...a, ', ', x] : [x]), [])}</div>}
        {p.verifiedBy.length > 0 && <div>verified by {p.verifiedBy.map(link)}</div>}
        {o.kind === 'neural_network' && o.state.trainedBy && <div>weights from training run {link(o.state.trainedBy)}</div>}
        {o.kind === 'neural_network' && o.state.handEdited && <div>weights edited by hand</div>}
        {p.note && <div className="muted">{p.note}</div>}
        {o.kind === 'claim' && o.state.status !== 'unverified' && <div>status set by verify_claim from evidence — not by assertion</div>}
      </div>

      {rels.length > 0 && (
        <>
          <h5>Relations</h5>
          <div className="small">
            {rels.map((r) => (
              <div key={r.id} className="row" style={{ justifyContent: 'space-between' }}>
                <span>
                  {r.from === o.id ? 'this' : link(r.from)} <span className="muted">{r.type.replace('_', ' ')}</span> {r.to === o.id ? 'this' : link(r.to)}
                </span>
                <button className="btn icon" title="remove relation" onClick={() => ui.act([{ op: 'disconnect', id: r.id }])}>×</button>
              </div>
            ))}
          </div>
        </>
      )}

      <h5>History</h5>
      <div className="hist">
        {history.map(({ tx, event }, i) => (
          <div key={i}>
            <span className="t">{fmtTime(tx.at).slice(0, 8)}</span>
            <span>{who(tx.actor)}</span>
            <span className="muted">{event.type}</span>
            <span>{event.op !== event.type ? event.op : ''}</span>
          </div>
        ))}
      </div>

      <h5 className="link" onClick={() => setShowAI(!showAI)} style={{ cursor: 'pointer' }}>{showAI ? '▾' : '▸'} What the AI sees</h5>
      {showAI && <pre className="json">{JSON.stringify((semanticView(ui.ws, [o.id]) as any).objects.find((x: any) => x.id === o.id), null, 1)}</pre>}
    </div>
  );
}

export function BranchDiffPanel({ diff, onClose }: { diff: BranchDiff; onClose: () => void }) {
  const ui = useUI();
  const bs = ui.kernel.branches;
  return (
    <div className="inspector" onPointerDown={(e) => e.stopPropagation()}>
      <button className="close" onClick={onClose}>×</button>
      <div className="small muted">Branch comparison</div>
      <h3>{bs[diff.a].name} ⇄ {bs[diff.b].name}</h3>
      <div className="small" style={{ marginTop: 4 }}>
        common ancestor: <b>{diff.common ? bs[diff.common].name : 'none'}</b>
        {bs[diff.b].assumption && <div style={{ color: 'var(--ai)' }}>{bs[diff.b].name} assumes: {bs[diff.b].assumption}</div>}
      </div>
      <h5>Only in {bs[diff.a].name}</h5>
      <div className="small">{diff.onlyInA.length ? diff.onlyInA.join(', ') : <span className="muted">nothing</span>}</div>
      <h5>Only in {bs[diff.b].name}</h5>
      <div className="small">{diff.onlyInB.length ? diff.onlyInB.join(', ') : <span className="muted">nothing</span>}</div>
      <h5>Changed</h5>
      {diff.changed.length === 0 && <div className="small muted">no shared object differs</div>}
      {diff.changed.map((c) => (
        <div key={c.id} className="small" style={{ marginBottom: 6 }}>
          <b>{c.label}</b> <span className="muted">({c.fields.join(', ')})</span>
          {c.params.map((p) => (
            <div key={p.name} className="mono">
              {p.name}: {JSON.stringify(p.a)} → {JSON.stringify(p.b)}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
