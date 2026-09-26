// The workspace kernel: the single source of truth. It owns the event-sourced history,
// branches and undo/redo, validates every operation from every client, and notifies
// subscribers. The AI is just one client of this class.

import type { ActorKind, Branch, ObjectId, Operation, OpResult, TSObject, Transaction, Workspace, WorkspaceEvent } from './types';
import { emptyWorkspace } from './types';
import { compile, OpError, TxBuilder } from './ops';
import { replay } from './reduce';

export interface DispatchOptions {
  /** consecutive transactions with the same key (and actor) collapse into one — e.g. dragging a weight */
  coalesceKey?: string;
  summary?: string;
  /** $ref names bound by earlier batches (an agent's turn spans several batches) */
  refs?: Record<string, ObjectId>;
}

export interface BranchDiff {
  a: string;
  b: string;
  common: string | null;
  onlyInA: ObjectId[];
  onlyInB: ObjectId[];
  changed: { id: ObjectId; label: string; fields: string[]; params: { name: string; a: unknown; b: unknown }[] }[];
}

const MAX_HISTORY_OBJECTS = 60;

export class Kernel {
  branches: Record<string, Branch> = {};
  current = 'main';
  version = 0;
  private cache = new Map<string, Workspace[]>();
  private listeners = new Set<() => void>();
  private txCounter = 0;
  private branchCounter = 0;

  constructor() {
    this.branches.main = { id: 'main', name: 'main', parent: null, forkIndex: 0, transactions: [], cursor: 0, createdAt: Date.now(), createdBy: 'system' };
  }

  // ------------------------------------------------------------ observation

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed() {
    this.version++;
    for (const l of this.listeners) l();
  }

  get branch(): Branch {
    return this.branches[this.current];
  }

  state(): Workspace {
    return this.stateAt(this.current, this.branch.cursor);
  }

  /** state of a branch after its first k own transactions */
  stateAt(branchId: string, k: number): Workspace {
    const b = this.branches[branchId];
    let snaps = this.cache.get(branchId);
    if (!snaps) {
      const base = b.parent ? this.stateAt(b.parent, b.forkIndex) : emptyWorkspace();
      snaps = [base];
      this.cache.set(branchId, snaps);
    }
    while (snaps.length <= k) {
      const tx = b.transactions[snaps.length - 1];
      snaps.push(replay(snaps[snaps.length - 1], tx.events));
    }
    return snaps[k];
  }

  private invalidate(branchId: string, from: number) {
    const snaps = this.cache.get(branchId);
    if (snaps) snaps.length = Math.min(snaps.length, from + 1);
  }

  /** transactions visible from the current branch, oldest first, with their branch */
  lineage(branchId = this.current): { tx: Transaction; branch: string }[] {
    const b = this.branches[branchId];
    const own = b.transactions.slice(0, b.cursor).map((tx) => ({ tx, branch: b.id }));
    if (!b.parent) return own;
    const parent = this.lineageUpTo(b.parent, b.forkIndex);
    return parent.concat(own);
  }

  private lineageUpTo(branchId: string, k: number): { tx: Transaction; branch: string }[] {
    const b = this.branches[branchId];
    const own = b.transactions.slice(0, k).map((tx) => ({ tx, branch: b.id }));
    return b.parent ? this.lineageUpTo(b.parent, b.forkIndex).concat(own) : own;
  }

  /** every event in the current lineage that touched an object */
  historyOf(id: ObjectId): { tx: Transaction; event: WorkspaceEvent; branch: string }[] {
    const out: { tx: Transaction; event: WorkspaceEvent; branch: string }[] = [];
    for (const { tx, branch } of this.lineage())
      for (const e of tx.events) {
        const touches =
          (e.type === 'ObjectCreated' && e.object.id === id) ||
          ((e.type === 'ObjectModified' || e.type === 'ObjectDeleted') && e.id === id) ||
          (e.type === 'RelationAdded' && (e.relation.from === id || e.relation.to === id)) ||
          ('subject' in e && e.subject === id);
        if (touches) out.push({ tx, event: e, branch });
      }
    return out.slice(-MAX_HISTORY_OBJECTS);
  }

  // ---------------------------------------------------------------- mutation

  /** Validate and apply a batch of operations atomically. */
  dispatch(ops: Operation[], actor: ActorKind, opts: DispatchOptions = {}): OpResult {
    const b = this.branch;
    const last = b.cursor > 0 ? b.transactions[b.cursor - 1] : undefined;
    const coalesce =
      !!opts.coalesceKey && !!last && last.coalesceKey === opts.coalesceKey && last.actor === actor && b.cursor === b.transactions.length;
    const baseIndex = coalesce ? b.cursor - 1 : b.cursor;
    const base = this.stateAt(this.current, baseIndex);
    const txId = coalesce ? last!.id : `tx_${Date.now().toString(36)}_${++this.txCounter}`;
    const tx = new TxBuilder(base, actor, txId, Date.now(), opts.refs);
    const errors: string[] = [];
    if (!Array.isArray(ops) || ops.length === 0) errors.push('expected a non-empty list of operations');
    else
      ops.forEach((op, i) => {
        if (errors.length) return;
        try {
          compile(tx, op);
        } catch (e) {
          const msg = e instanceof OpError ? e.message : `internal error: ${(e as Error).message}`;
          errors.push(`operation ${i + 1} (${op?.op ?? '?'}): ${msg}`);
        }
      });
    if (errors.length) return { ok: false, errors, refs: {}, created: [], notes: [] };
    tx.finish();

    const transaction: Transaction = {
      id: txId,
      actor,
      at: tx.at,
      ops,
      events: tx.events,
      summary: opts.summary ?? summarize(ops),
      ...(opts.coalesceKey ? { coalesceKey: opts.coalesceKey } : {}),
    };
    this.detachChildrenBeyond(b, baseIndex);
    b.transactions = b.transactions.slice(0, baseIndex);
    b.transactions.push(transaction);
    b.cursor = b.transactions.length;
    this.invalidate(this.current, baseIndex);
    this.invalidateChildren(this.current);
    this.changed();
    return { ok: true, errors: [], refs: tx.refs, created: tx.created, txId, notes: tx.notes };
  }

  /** Dry-run: would these operations validate? */
  validate(ops: Operation[], actor: ActorKind): string[] {
    const tx = new TxBuilder(this.state(), actor, 'dry', Date.now());
    const errors: string[] = [];
    ops.forEach((op, i) => {
      if (errors.length) return;
      try {
        compile(tx, op);
      } catch (e) {
        errors.push(`operation ${i + 1} (${op?.op ?? '?'}): ${(e as Error).message}`);
      }
    });
    return errors;
  }

  /**
   * Before a branch discards its redo tail, any child branch that forked inside that tail
   * takes its own copy of the transactions it depends on, so its history stays intact.
   */
  private detachChildrenBeyond(b: Branch, keep: number) {
    if (b.transactions.length <= keep) return;
    for (const c of Object.values(this.branches))
      if (c.parent === b.id && c.forkIndex > keep) {
        const inherited = b.transactions.slice(keep, c.forkIndex);
        c.transactions = [...inherited, ...c.transactions];
        c.cursor += inherited.length;
        c.forkIndex = keep;
        this.cache.delete(c.id);
        for (const g of Object.values(this.branches)) if (g.parent === c.id) g.forkIndex += inherited.length;
      }
  }

  private invalidateChildren(parent: string) {
    for (const b of Object.values(this.branches))
      if (b.parent === parent) {
        this.cache.delete(b.id);
        this.invalidateChildren(b.id);
      }
  }

  canUndo(): boolean {
    return this.branch.cursor > 0;
  }

  canRedo(): boolean {
    return this.branch.cursor < this.branch.transactions.length;
  }

  undo(): Transaction | undefined {
    if (!this.canUndo()) return;
    const tx = this.branch.transactions[this.branch.cursor - 1];
    this.branch.cursor--;
    this.changed();
    return tx;
  }

  redo(): Transaction | undefined {
    if (!this.canRedo()) return;
    const tx = this.branch.transactions[this.branch.cursor];
    this.branch.cursor++;
    this.changed();
    return tx;
  }

  // ---------------------------------------------------------------- branches

  fork(name: string, assumption: string | undefined, actor: ActorKind): string {
    const id = `b${++this.branchCounter}_${Date.now().toString(36)}`;
    // Transactions beyond the cursor (undone ones) stay on the parent; the fork starts from what you see.
    this.branches[id] = {
      id,
      name: name.trim() || `branch ${this.branchCounter}`,
      ...(assumption ? { assumption } : {}),
      parent: this.current,
      forkIndex: this.branch.cursor,
      transactions: [],
      cursor: 0,
      createdAt: Date.now(),
      createdBy: actor,
    };
    this.current = id;
    this.changed();
    return id;
  }

  switchBranch(id: string) {
    if (!this.branches[id] || id === this.current) return;
    this.current = id;
    this.changed();
  }

  /** nearest common ancestor branch of two branches */
  commonAncestor(a: string, b: string): string | null {
    const chain = (x: string) => {
      const out: string[] = [];
      for (let c: string | null = x; c; c = this.branches[c].parent) out.push(c);
      return out;
    };
    const ca = chain(a);
    return chain(b).find((x) => ca.includes(x)) ?? null;
  }

  diffBranches(a: string, b: string): BranchDiff {
    const A = this.stateAt(a, this.branches[a].cursor);
    const B = this.stateAt(b, this.branches[b].cursor);
    const onlyInA = Object.keys(A.objects).filter((id) => !B.objects[id]);
    const onlyInB = Object.keys(B.objects).filter((id) => !A.objects[id]);
    const changed: BranchDiff['changed'] = [];
    for (const id of Object.keys(A.objects)) {
      const x = A.objects[id];
      const y = B.objects[id];
      if (!y) continue;
      const fields: string[] = [];
      if (x.label !== y.label) fields.push('label');
      if (JSON.stringify(x.state) !== JSON.stringify(y.state)) fields.push('state');
      if (JSON.stringify(x.params) !== JSON.stringify(y.params)) fields.push('params');
      if (x.visual.x !== y.visual.x || x.visual.y !== y.visual.y) fields.push('position');
      const params = Object.keys({ ...x.params, ...y.params })
        .filter((k) => JSON.stringify(x.params[k]) !== JSON.stringify(y.params[k]))
        .map((k) => ({ name: k, a: x.params[k], b: y.params[k] }));
      if (fields.length) changed.push({ id, label: y.label, fields, params });
    }
    return { a, b, common: this.commonAncestor(a, b), onlyInA, onlyInB, changed };
  }

  // ---------------------------------------------------------------- persistence

  serialize(): string {
    return JSON.stringify({ v: 1, current: this.current, branches: this.branches, txCounter: this.txCounter, branchCounter: this.branchCounter });
  }

  load(json: string): boolean {
    try {
      const d = JSON.parse(json);
      if (d?.v !== 1 || !d.branches?.main) return false;
      this.branches = d.branches;
      this.current = d.branches[d.current] ? d.current : 'main';
      this.txCounter = d.txCounter ?? 0;
      this.branchCounter = d.branchCounter ?? 0;
      this.cache.clear();
      this.state(); // replay now so corrupt logs fail here
      this.changed();
      return true;
    } catch {
      return false;
    }
  }

  reset() {
    this.branches = { main: { id: 'main', name: 'main', parent: null, forkIndex: 0, transactions: [], cursor: 0, createdAt: Date.now(), createdBy: 'system' } };
    this.current = 'main';
    this.cache.clear();
    this.changed();
  }

  object(id: ObjectId): TSObject | undefined {
    return this.state().objects[id];
  }
}

function summarize(ops: Operation[]): string {
  const names = ops.map((o) => o.op);
  const counts = new Map<string, number>();
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
  return [...counts].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)).join(', ');
}
