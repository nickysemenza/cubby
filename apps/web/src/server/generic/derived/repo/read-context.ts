import type { StoredFieldDecision } from "@cubby/schemas/derived-value";
import type { ReadableFieldEnvelope } from "@cubby/schemas/field-envelope";
import { z } from "zod";

/** Batch read facts without importing database or hydration implementations. */
export interface StoredDerivedRead {
  readonly value: unknown;
  readonly evidence?: StoredFieldDecision["evidence"];
  readonly computedAt: string | null;
  readonly decision?: Extract<
    ReadableFieldEnvelope["result"],
    { kind: "live" }
  >["decision"];
  readonly resultExists: boolean;
  readonly stale: boolean;
}

export type PageStoredMeta = ReadonlyMap<
  string,
  ReadonlyMap<string, StoredDerivedRead>
>;

export const currentReadFacts = z.record(z.string(), z.unknown());
export type CurrentReadFacts = Readonly<z.output<typeof currentReadFacts>>;

/** Internal page facts; never part of a transport response. */
export type FieldReadContext = Readonly<{
  /** Governed output keys whose assignment facts were loaded. */
  covered: readonly string[];
  raw: CurrentReadFacts;
  stored: ReadonlyMap<string, StoredDerivedRead>;
}>;

export type PageFieldReadContexts = ReadonlyMap<string, FieldReadContext>;
