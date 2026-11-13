/**
 * Kernel key spellings and canonical hashing. A key is the unit of
 * dependency: a read records it, a mutation raises its `KeyRev` and dirties
 * every scope whose `ScopeDep` holds it.
 */
import { sha256Hex } from "@cubby/shared/sha256";

import type { FactRef, Json, Key, ScopeRef } from "./define";

/** A row of a declared table, read by id. */
export const rowKey = (table: string, id: string): Key => `row:${table}:${id}`;
/** Membership and values of a declared roster, including an empty roster. */
export const tableKey = (table: string): Key => `table:${table}`;
/** Every decision on one subject, across channels. */
export const decisionKey = (subject: string): Key => `decision:${subject}`;
export const answerKey = (inputHash: string): Key => `answer:${inputHash}`;
export const bindingEventKey = (eventKey: string): Key =>
  `binding:event:${eventKey}`;
export const bindingFactKey = (fact: FactRef): Key =>
  `binding:fact:${fact.kind}:${fact.id}`;

/** A decision subject for a record. */
export const recordSubject = (entity: string, id: string) => `${entity}:${id}`;
/** A drift proposal's approval subject, by item or by class. */
export const driftSubject = (scope: ScopeRef | { kind: string }) =>
  "key" in scope ? `drift:${scope.kind}:${scope.key}` : `drift:${scope.kind}`;

/** A record that existed at cutover; immutable. */
export const legacyKey = (id: string) => `legacy:${id}`;

/** Separates a veto slot's field from its value key; Postgres text holds no NUL. */
export const VETO_SEPARATOR = "\u001f";

/** JSON with object keys sorted, so equal values hash equally. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- hashes any JSON-shaped value; canonicalize checks every node and throws on the rest.
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): Json {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(
      entries.map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return value;
  if (typeof value === "bigint") return value.toString();
  throw new Error(`Kernel cannot hash a ${typeof value} value`);
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- as canonicalJson.
export const hashCanonical = (value: unknown) =>
  sha256Hex(canonicalJson(value));
