// The pure event reducer: (workspace, event) → workspace. Replay = fold.

import type { Workspace, WorkspaceEvent } from './types';

export function reduce(ws: Workspace, ev: WorkspaceEvent): Workspace {
  switch (ev.type) {
    case 'ObjectCreated':
      return { ...ws, objects: { ...ws.objects, [ev.object.id]: ev.object } };
    case 'ObjectModified': {
      const o = ws.objects[ev.id];
      if (!o) return ws;
      return { ...ws, objects: { ...ws.objects, [ev.id]: { ...o, ...ev.set } } };
    }
    case 'ObjectDeleted': {
      const objects = { ...ws.objects };
      delete objects[ev.id];
      return { ...ws, objects };
    }
    case 'RelationAdded':
      return { ...ws, relations: { ...ws.relations, [ev.relation.id]: ev.relation } };
    case 'RelationRemoved': {
      const relations = { ...ws.relations };
      delete relations[ev.id];
      return { ...ws, relations };
    }
    case 'GlyphDefined':
      return { ...ws, glyphs: { ...ws.glyphs, [ev.definition.id]: ev.definition } };
    case 'CounterAdvanced':
      return { ...ws, counter: ev.counter };
    default:
      return ws; // marker events carry meaning for history and provenance only
  }
}

export function replay(ws: Workspace, events: WorkspaceEvent[]): Workspace {
  let s = ws;
  for (const e of events) s = reduce(s, e);
  return s;
}
