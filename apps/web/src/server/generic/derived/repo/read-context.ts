import type { StoredFieldDecision } from "@cubby/schemas/derived-value";
import type {
  fieldAssignmentOwnership,
  ReadableFieldEnvelope,
} from "@cubby/schemas/field-envelope";
import { z } from "zod";

/** Batch read facts without importing database or hydration implementations. */
export interface StoredDerivedRead {
  readonly value: unknown;
  readonly evidence?: StoredFieldDecision["evidence"];
  readonly computedAt: string | null;
  readonly error: string | null;
  readonly decision?: Extract<
    ReadableFieldEnvelope["result"],
    { kind: "live" }
  >["decision"];
  readonly resultExists: boolean;
  readonly stale: boolean;
  /** Actual queued work; expiry alone does not imply a worker is pending. */
  readonly pending?: boolean;
  readonly retryAt: string | null;
}

export type PageStoredMeta = ReadonlyMap<
  string,
  ReadonlyMap<string, StoredDerivedRead>
>;

export type CurrentFieldOwnership = Record<
  string,
  Extract<z.output<typeof fieldAssignmentOwnership>, { kind: "automatic" }>
>;

export const currentReadFacts = z.record(z.string(), z.unknown());
export type CurrentReadFacts = Readonly<z.output<typeof currentReadFacts>>;

/** Internal page facts; never part of a transport response. */
export type FieldReadContext = Readonly<{
  raw: CurrentReadFacts;
  stored: ReadonlyMap<string, StoredDerivedRead>;
  ownership: CurrentFieldOwnership;
}>;

export type PageFieldReadContexts = ReadonlyMap<string, FieldReadContext>;
