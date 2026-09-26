// Core semantic types for the ThoughtSpace workspace kernel.
// The kernel is framework-independent: nothing in src/kernel imports React.

export type ObjectId = string;
export type RelationId = string;
export type ActorKind = 'human' | 'ai' | 'system';

export type ObjectKind =
  | 'text'
  | 'equation'
  | 'function'
  | 'graph'
  | 'neural_network'
  | 'dataset'
  | 'simulation'
  | 'experiment'
  | 'comparison'
  | 'claim'
  | 'group'
  | 'glyph'
  | 'sketch';

export type ParamValue = number | string | boolean | number[] | null;

export interface ParamSpec {
  name: string;
  type: 'number' | 'int' | 'enum' | 'int_list' | 'string' | 'bool';
  description: string;
  default: ParamValue;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  /** int_list constraints */
  maxLength?: number;
}

export interface Port {
  name: string;
  type: 'data' | 'model' | 'series' | 'function' | 'any';
}

export interface VisualState {
  x: number;
  y: number;
  w: number;
  h: number;
  /** hidden because it lives inside a collapsed glyph */
  hidden?: boolean;
  /** glyph expanded to show its construction */
  expanded?: boolean;
}

export interface ProvenanceEntry {
  actor: ActorKind;
  at: number;
  op: string;
  txId: string;
  note?: string;
}

export interface Provenance {
  createdBy: ActorKind;
  createdAt: number;
  operation: string;
  txId: string;
  derivedFrom: ObjectId[];
  experiment?: ObjectId;
  verifiedBy: ObjectId[];
  assumption?: string;
  note?: string;
  history: ProvenanceEntry[];
}

export interface TSObject<S = any> {
  id: ObjectId;
  kind: ObjectKind;
  label: string;
  params: Record<string, ParamValue>;
  state: S;
  visual: VisualState;
  provenance: Provenance;
  parent?: ObjectId;
}

export type RelationType =
  | 'feeds_into'
  | 'visualizes'
  | 'derived_from'
  | 'branched_from'
  | 'compares_with'
  | 'verified_by'
  | 'annotates'
  | 'composed_of'
  | 'generated_from'
  | 'parameterizes'
  | 'instance_of';

export const RELATION_TYPES: RelationType[] = [
  'feeds_into',
  'visualizes',
  'derived_from',
  'branched_from',
  'compares_with',
  'verified_by',
  'annotates',
  'composed_of',
  'generated_from',
  'parameterizes',
  'instance_of',
];

export interface Relation {
  id: RelationId;
  type: RelationType;
  from: ObjectId;
  to: ObjectId;
  /** free-form semantic metadata, e.g. the assumption behind a branch */
  meta?: Record<string, unknown>;
  createdBy: ActorKind;
  txId: string;
}

export interface ExposedParam {
  /** name shown on the glyph */
  name: string;
  /** inner object id */
  id: ObjectId;
  param: string;
}

export interface GlyphDefinition {
  id: string;
  name: string;
  description: string;
  /** frozen snapshot of the construction, with ids relative to the template */
  objects: TSObject[];
  relations: Relation[];
  exposed: ExposedParam[];
  /** inner object whose output the glyph presents */
  output?: ObjectId;
  /** data the construction received from outside it (reconnected on reuse when still present) */
  inputs: { member: ObjectId; from: ObjectId }[];
  createdBy: ActorKind;
  createdAt: number;
  sourceGlyph: ObjectId;
}

export interface Workspace {
  objects: Record<ObjectId, TSObject>;
  relations: Record<RelationId, Relation>;
  glyphs: Record<string, GlyphDefinition>;
  /** monotonic counter used for id generation; lives in state so replay is deterministic */
  counter: number;
}

export const emptyWorkspace = (): Workspace => ({ objects: {}, relations: {}, glyphs: {}, counter: 0 });

// ---------------------------------------------------------------- events

export type EventType =
  | 'ObjectCreated'
  | 'ObjectModified'
  | 'ObjectDeleted'
  | 'RelationAdded'
  | 'RelationRemoved'
  | 'ObjectAbstracted'
  | 'GlyphDefined'
  | 'ComputationExecuted'
  | 'ExperimentStarted'
  | 'ExperimentCompleted'
  | 'VariantCreated'
  | 'BranchCompared'
  | 'ClaimGenerated'
  | 'ClaimVerified'
  | 'Annotated'
  | 'CounterAdvanced';

export interface EventBase {
  type: EventType;
  actor: ActorKind;
  at: number;
  txId: string;
  op: string;
}

export type WorkspaceEvent =
  | (EventBase & { type: 'ObjectCreated'; object: TSObject })
  | (EventBase & {
      type: 'ObjectModified';
      id: ObjectId;
      /** fully materialised new values of the changed top-level fields */
      set: Partial<Pick<TSObject, 'label' | 'params' | 'state' | 'visual' | 'provenance' | 'parent'>>;
    })
  | (EventBase & { type: 'ObjectDeleted'; id: ObjectId })
  | (EventBase & { type: 'RelationAdded'; relation: Relation })
  | (EventBase & { type: 'RelationRemoved'; id: RelationId })
  | (EventBase & { type: 'GlyphDefined'; definition: GlyphDefinition })
  | (EventBase & { type: 'CounterAdvanced'; counter: number })
  | (EventBase & {
      type:
        | 'ObjectAbstracted'
        | 'ComputationExecuted'
        | 'ExperimentStarted'
        | 'ExperimentCompleted'
        | 'VariantCreated'
        | 'BranchCompared'
        | 'ClaimGenerated'
        | 'ClaimVerified'
        | 'Annotated';
      /** marker events: meaning for history/provenance, no direct state effect */
      subject: ObjectId;
      detail?: Record<string, unknown>;
    });

export interface Transaction {
  id: string;
  actor: ActorKind;
  at: number;
  /** operations as submitted (after $ref resolution) — the "why" of the events */
  ops: Operation[];
  events: WorkspaceEvent[];
  summary: string;
  coalesceKey?: string;
}

export interface Branch {
  id: string;
  name: string;
  assumption?: string;
  parent: string | null;
  /** number of parent transactions (up to the parent's cursor at fork time) included */
  forkIndex: number;
  transactions: Transaction[];
  /** number of transactions currently applied (undo moves this back) */
  cursor: number;
  createdAt: number;
  createdBy: ActorKind;
}

// ---------------------------------------------------------------- operations

export type SemanticPlacement =
  | { beside: ObjectId }
  | { below: ObjectId }
  | { above: ObjectId }
  | { left_of: ObjectId }
  | { near: ObjectId }
  | { at: { x: number; y: number } }
  /** the nearest free spot to a point (the human's viewport centre, say) */
  | { around: { x: number; y: number } };

export type Operation = { op: string; [k: string]: any };

export interface OpResult {
  ok: boolean;
  errors: string[];
  /** $ref → concrete id for objects created in this batch */
  refs: Record<string, ObjectId>;
  created: ObjectId[];
  txId?: string;
  /** human/AI readable outcome lines (e.g. training results) */
  notes: string[];
}
