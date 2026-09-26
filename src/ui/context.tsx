import { createContext, useContext, useSyncExternalStore } from 'react';
import type { Kernel, ObjectId, Operation, OpResult, Workspace } from '../kernel';

export type Detail = 'glance' | 'normal' | 'detail';

export interface UI {
  kernel: Kernel;
  ws: Workspace;
  /** dispatch as the human */
  act(ops: Operation[], opts?: { coalesceKey?: string; summary?: string }): OpResult;
  selection: ObjectId[];
  select(ids: ObjectId[], additive?: boolean): void;
  isHighlighted(id: string, sub?: string): boolean;
  detail: Detail;
  /** current probe input (hovering a data point lights up the network) */
  probe: [number, number] | null;
  setProbe(p: [number, number] | null): void;
  ask(text: string, selection?: ObjectId[]): void;
  dismissed: Set<string>;
  dismiss(key: string): void;
  focus(ids: ObjectId[]): void;
  viewportCenter(): { x: number; y: number };
}

export const UICtx = createContext<UI | null>(null);

export function useUI(): UI {
  const v = useContext(UICtx);
  if (!v) throw new Error('UI context missing');
  return v;
}

export function useKernelVersion(k: Kernel): number {
  return useSyncExternalStore(
    (fn) => k.subscribe(fn),
    () => k.version,
  );
}
