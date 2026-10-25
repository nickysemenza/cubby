/**
 * The derived value envelope (ADR 0021). A derived field keeps its value in
 * its ordinary field slot; a row's `derived` sidecar carries, per field, its
 * state, the level that decided it and when it was computed. Web, Apple and
 * MCP read this one shape.
 */
import { z } from "zod";

/** `fresh`: current. `stale`: an input changed and recompute is queued.
 * `missing`: never computed. `waiting`: paid work is waiting on its lane.
 * `failed`: the last recompute failed; the previous value is kept. */
export const derivedState = z.enum([
  "fresh",
  "stale",
  "missing",
  "waiting",
  "failed",
]);
export type DerivedState = z.infer<typeof derivedState>;

export const derivedEntityRef = z.object({
  entity: z.string(),
  id: z.string(),
  label: z.string().nullable(),
});

/** The level of a value's decision chain that decided it. */
export const decidedBy = z.discriminatedUnion("level", [
  z.object({ level: z.literal("own") }),
  z.object({
    level: z.literal("inherited"),
    source: derivedEntityRef,
  }),
  z.object({
    level: z.literal("default"),
    source: derivedEntityRef.nullable(),
  }),
  z.object({
    level: z.literal("suggested"),
    confidence: z.number().min(0).max(1),
    auto: z.boolean(),
  }),
  z.object({ level: z.literal("computed") }),
  z.object({ level: z.literal("unresolved") }),
]);
export type DecidedBy = z.infer<typeof decidedBy>;

export const derivedMeta = z.object({
  state: derivedState,
  decidedBy: decidedBy.nullable(),
  /** ISO timestamp of the stored computation; null for live or missing values. */
  asOf: z.string().nullable(),
  error: z.string().nullable().optional(),
});
export type DerivedMeta = z.infer<typeof derivedMeta>;

/** A row's per-field sidecar. */
export const derivedSidecar = z.record(z.string(), derivedMeta);
export type DerivedSidecar = z.infer<typeof derivedSidecar>;

/** A live, always-current value's meta. */
export const liveDerivedMeta = (decided: DecidedBy | null): DerivedMeta => ({
  state: "fresh",
  decidedBy: decided,
  asOf: null,
});
