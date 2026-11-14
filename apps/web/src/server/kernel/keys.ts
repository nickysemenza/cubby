import {
  SHORTCODE_CHARS,
  SHORTCODE_BODY_LENGTH,
  SHORTCODE_PREFIX,
  type ShortcodeType,
} from "@cubby/shared";
/**
 * Kernel key spellings and canonical hashing. A key is the unit of
 * dependency: a read records it, a mutation raises its `KeyRev` and dirties
 * every scope whose `ScopeDep` holds it.
 */
import { sha256Hex } from "@cubby/shared/sha256";

import { sha256Text } from "~/server/lib/sha256-text";

import type { FactRef, Json, Key, ScopeRef } from "./define";

/** A row of a declared table, read by id. */
export const rowKey = (table: string, id: string): Key => `row:${table}:${id}`;
/** Membership and values of a declared table, including empty predicate reads. */
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

/** UUID v8 from the immutable ownership key, never the record's contents. */
export function recordIdentity(
  scope: ScopeRef,
  table: string,
  naturalKey: string,
): string {
  const hash = sha256Text(
    JSON.stringify([
      "cubby.RecordKey",
      scope.kind,
      scope.key,
      table,
      naturalKey,
    ]),
  );
  const variant = ((Number.parseInt(hash[16]!, 16) & 3) | 8).toString(16);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

/** Deterministic public code, retaining tombstones and other reserved codes. */
export function recordShortcode(
  entity: ShortcodeType,
  id: string,
  reserved: ReadonlyMap<string, string>,
): string {
  for (let attempt = 0; attempt < 100; attempt++) {
    const hash = sha256Text(JSON.stringify(["cubby.shortcode", id, attempt]));
    const body = Array.from(
      { length: SHORTCODE_BODY_LENGTH },
      (_, index) =>
        SHORTCODE_CHARS[
          Number.parseInt(hash.slice(index * 2, index * 2 + 2), 16) %
            SHORTCODE_CHARS.length
        ],
    ).join("");
    const code = `${SHORTCODE_PREFIX[entity]}${body}`;
    if (!reserved.has(code) || reserved.get(code) === id) return code;
  }
  throw new Error("Could not reserve a reconciled record's shortcode");
}

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

export const indexKey = (name: string, value: string): Key =>
  `index:${name}:${value}`;

export const columnKey = (table: string, column: string): Key =>
  `column:${table}:${column}`;
