// The semantic workspace representation handed to AI clients: objects, relations,
// computed facts — never pixels.

import type { ObjectId, Workspace } from './types';
import { kindSpec, KINDS } from './kinds';
import { OPS } from './ops';
import { CALC_DOC } from './ops-calc';

export function semanticView(ws: Workspace, selection: ObjectId[] = []): Record<string, unknown> {
  const objects = Object.values(ws.objects).map((o) => ({
    id: o.id,
    kind: o.kind,
    label: o.label,
    ...(o.visual.hidden ? { inside: o.parent } : {}),
    created_by: o.provenance.createdBy,
    ...(o.provenance.assumption ? { assumption: o.provenance.assumption } : {}),
    ...kindSpec(o.kind)!.summarize(o, ws),
  }));
  return {
    selection,
    objects,
    relations: Object.values(ws.relations).map((r) => [r.from, r.type, r.to, ...(r.meta ? [r.meta] : [])]),
    glyph_library: Object.values(ws.glyphs).map((g) => ({ id: g.id, name: g.name, exposes: g.exposed.map((e) => e.name) })),
  };
}

/** Protocol documentation generated from the registry — shown to the AI. */
export function protocolDoc(): string {
  const kinds = Object.values(KINDS)
    .map((k) => {
      const params = k.params.map((p) => `${p.name}: ${p.type}${p.options ? ` (${p.options.join('|')})` : ''} — ${p.description}`).join('; ');
      const actions = Object.entries(k.actions ?? {})
        .map(([n, a]) => `${n}(${a.args.map((x) => x.name).join(', ')}) — ${a.description}`)
        .join('; ');
      return `- ${k.kind}${k.creatable ? '' : ' (produced by operations only)'}: ${k.description}${params ? `\n    params: ${params}` : ''}${actions ? `\n    actions (via invoke): ${actions}` : ''}`;
    })
    .join('\n');
  const ops = OPS.map((o) => `- ${o.op} ${o.args}: ${o.summary}`).join('\n');
  return `OBJECT KINDS\n${kinds}\n\nOPERATIONS\n${ops}\n\n${CALC_DOC}`;
}
