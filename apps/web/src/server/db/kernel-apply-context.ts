/**
 * Marks the evidence-facts kernel's apply step (ADR 0029 section 2). Inside
 * it, writes to reconciler-owned columns are allowed and audit rows carry the
 * apply's provenance; everywhere else such writes are refused.
 */
import { AsyncLocalStorage } from "node:async_hooks";

import type { KernelAuditProvenance } from "@cubby/schemas/kernel/machinery";

type ApplyScope = { kind: string; key: string };

const kernelApply = new AsyncLocalStorage<{
  provenance: KernelAuditProvenance | null;
  records?: ReadonlyMap<string, KernelAuditProvenance>;
  scopes: readonly ApplyScope[];
}>();

/**
 * `scopes` are the scopes being applied; a nested apply keeps the outer ones,
 * so a delete policy or repoint inside an apply never dirties them.
 */
export const withKernelApply = <T>(
  provenance: KernelAuditProvenance | null,
  work: () => Promise<T>,
  records?: ReadonlyMap<string, KernelAuditProvenance>,
  scopes?: readonly ApplyScope[],
): Promise<T> =>
  kernelApply.run(
    {
      provenance,
      records,
      scopes: scopes ?? kernelApply.getStore()?.scopes ?? [],
    },
    work,
  );

export const inKernelApply = () => kernelApply.getStore() !== undefined;

/** The scopes the running apply publishes; their own writes never dirty them. */
export const kernelApplyScopes = () => kernelApply.getStore()?.scopes ?? [];

/** The running apply's provenance, for the audit rows it writes. */
export const kernelApplyProvenance = (entity?: string, id?: string) => {
  const context = kernelApply.getStore();
  return (
    (entity && id ? context?.records?.get(`${entity}:${id}`) : null) ??
    context?.provenance ??
    null
  );
};
