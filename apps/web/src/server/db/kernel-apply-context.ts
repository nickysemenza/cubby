/**
 * Marks the evidence-facts kernel's apply step (ADR 0029 section 2). Inside
 * it, writes to reconciler-owned columns are allowed and audit rows carry the
 * apply's provenance; everywhere else such writes are refused.
 */
import { AsyncLocalStorage } from "node:async_hooks";

import type { KernelAuditProvenance } from "@cubby/schemas/kernel/machinery";

const kernelApply = new AsyncLocalStorage<{
  provenance: KernelAuditProvenance | null;
}>();

export const withKernelApply = <T>(
  provenance: KernelAuditProvenance | null,
  work: () => Promise<T>,
): Promise<T> => kernelApply.run({ provenance }, work);

export const inKernelApply = () => kernelApply.getStore() !== undefined;

/** The running apply's provenance, for the audit rows it writes. */
export const kernelApplyProvenance = () =>
  kernelApply.getStore()?.provenance ?? null;
