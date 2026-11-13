import { z } from "zod";

import {
  decisionChannel,
  decisionKind,
  kernelActor,
  kernelGap,
  kernelStage,
} from "./stage";

/** Any JSON value: answers, decision values, cursors. */
export const kernelJson = z.json();
export type KernelJson = z.infer<typeof kernelJson>;

/**
 * What decided a kernel apply, stored on each audit row it writes: the scope,
 * its reconciler version and the inputs it used (ADR 0029 section 1).
 */
export const kernelAuditProvenance = z.object({
  scope: z.object({ kind: z.string(), key: z.string() }),
  version: z.number().int().nonnegative(),
  inputs: z.array(z.json()),
});
export type KernelAuditProvenance = z.infer<typeof kernelAuditProvenance>;

/** ADR 0029 section 8: an owed producer call never leaves `unknown` on its own. */
export const askState = z.enum(["queued", "sent", "answered", "unknown"]);
export type AskState = z.infer<typeof askState>;

export const askProducer = z.enum(["model", "embedding", "image", "source"]);
export type AskProducer = z.infer<typeof askProducer>;

export const kernelLane = z.enum(["money", "catalog"]);
export type KernelLane = z.infer<typeof kernelLane>;

/** Why claimable work waits without spending an attempt. */
export const kernelWaitCause = z.enum([
  "funding",
  "provider_capacity",
  "in_flight",
  "rate_limit",
  "device",
]);
export type KernelWaitCause = z.infer<typeof kernelWaitCause>;

/** How evidence came to belong to a purchase event, strongest first. */
export const bindingBasis = z.enum(["decision", "baseline", "proven"]);
export type BindingBasis = z.infer<typeof bindingBasis>;

/** An input a scope's last run used, in use order; the machinery read expands it. */
const scopeInputRef = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("evidence"),
    fact: z.object({ kind: z.string(), id: z.string() }),
  }),
  z.object({
    kind: z.literal("decision"),
    id: z.string(),
    subject: z.string(),
  }),
  z.object({
    kind: z.literal("answer"),
    inputHash: z.string(),
    missing: z.boolean().optional(),
  }),
]);
export type ScopeInputRef = z.infer<typeof scopeInputRef>;

/** A collection capped at {@link MACHINERY_COLLECTION_CAP} rows. */
const capped = <T extends z.ZodType>(item: T) =>
  z.object({
    items: z.array(item),
    shown: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  });
export const MACHINERY_COLLECTION_CAP = 50;
/** A raw error's cap; the whole response is capped at 256 KB. */
export const MACHINERY_RAW_ERROR_BYTES = 16 * 1024;
export const MACHINERY_RESPONSE_BYTES = 256 * 1024;

const machineryQueue = z.object({
  position: z.number().int().positive(),
  of: z.number().int().positive(),
  /** Rank times the queue's median duration, or `availableAt` for a timer. */
  eta: z.iso.datetime().nullable(),
  basis: z.enum(["claim-order", "timer", "insufficient-history"]),
});

const machineryError = z.object({ class: z.string(), raw: z.string() });

const machineryGap = kernelGap.extend({
  queue: machineryQueue.nullable(),
  attempts: z
    .object({
      n: z.number().int().nonnegative(),
      max: z.number().int().positive(),
      nextAt: z.iso.datetime().nullable(),
    })
    .nullable(),
  lastError: machineryError.nullable(),
});
export type MachineryGap = z.infer<typeof machineryGap>;

const machineryInput = z.object({
  kind: z.enum(["evidence", "answer", "decision", "default"]),
  status: z.enum(["decided", "skipped", "gap", "blocked"]),
  /** Public shortcode of the source record, when it has one. */
  source: z.string().nullable(),
  at: z.iso.datetime().nullable(),
  by: z.string().nullable(),
  answer: z
    .object({
      model: z.string().nullable(),
      tier: z.string().nullable(),
      costMicros: z.number().int().nullable(),
      inputHash: z.string(),
      rawError: z.string().nullable(),
    })
    .nullable(),
  decision: z
    .object({
      channel: decisionChannel,
      kind: decisionKind,
      supersededBy: z.string().nullable(),
    })
    .nullable(),
});
export type MachineryInput = z.infer<typeof machineryInput>;

const machineryDrift = z.object({
  scope: z.object({ kind: z.string(), key: z.string() }),
  proposalHash: z.string(),
  inputsHash: z.string(),
  difference: z.json(),
  askCount: z.number().int().nonnegative(),
  estimatedCostMicros: z.number().int().nonnegative(),
});

/** One scope's part of a record's machinery, in owning, fields, quality order. */
const machineryScope = z.object({
  kind: z.string(),
  key: z.string(),
  reconciledAt: z.iso.datetime().nullable(),
  version: z.number().int().nonnegative().nullable(),
  error: machineryError.nullable(),
});

export const passWork = z.object({
  /** Pass pages do no paid work; their Asks carry producer cost. */
  costMicros: z.literal(0),
  name: z.string(),
  key: z.string(),
  stage: kernelStage,
  availableAt: z.iso.datetime(),
  waitCause: kernelWaitCause.nullable(),
  attempts: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  lastError: z.string().nullable(),
  doneAt: z.iso.datetime().nullable(),
  cancelledAt: z.iso.datetime().nullable(),
});
export type PassWork = z.infer<typeof passWork>;

/**
 * @public The machinery panel's operation output (ADR 0029 section 10).
 *
 * The `machinery` read (ADR 0029 section 10): one snapshot of a record's
 * scopes, gaps, inputs and drift, checked against the viewer's access.
 */
export const machinery = z.object({
  stage: kernelStage,
  nextActor: kernelActor.nullable(),
  computedAt: z.iso.datetime().nullable(),
  inputsChangedAt: z.iso.datetime().nullable(),
  scopes: z.array(machineryScope),
  gaps: capped(machineryGap),
  inputs: capped(machineryInput),
  drift: machineryDrift.nullable(),
  /** Pass instances that carry this Run. */
  passes: z.array(passWork).optional(),
  totalCostMicros: z.number().int().nonnegative(),
  /**
   * With `{ field }`: what "Let Cubby decide" would make the field, as a
   * field result, from its declared reset or the `fields` scope's derivation.
   */
  resetPreview: z
    .object({
      source: z.enum(["resolution", "derivation"]),
      result: z.json(),
      pendingAnswers: z.number().int().nonnegative(),
    })
    .nullable(),
  /** True when the 256 KB response cap dropped trailing collection items. */
  truncated: z.boolean(),
});
export type Machinery = z.infer<typeof machinery>;

/** Batched list summary; absent capability is null in the list read. */
export const machineryListFields = z.object({
  attempts: z.number().int().nonnegative(),
  costMicros: z.number().nonnegative(),
  stage: kernelStage,
  nextActor: kernelActor.nullable(),
  firstGap: z.string().nullable(),
  eta: z.iso.datetime().nullable(),
});
