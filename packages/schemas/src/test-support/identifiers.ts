import type { ShortcodeFor } from "@cubby/shared";
import { SHORTCODE_CHARS, SHORTCODE_PREFIX } from "@cubby/shared";
import type { DataQuality } from "../data-quality";
import {
  parseEntityId,
  parseShortcodeFor,
  userId,
  type EntityId,
  type UserId,
} from "../identifiers";
import type { ShortcodeEntity } from "../entity-manifest";

export type { EntityId, ShortcodeFor };

export function testUserId(seed: string): UserId {
  return userId.parse(seed);
}

/** Four independent 32-bit lanes keep the fixture value stable across runtimes. */
const hashLane = (value: string, lane: number): number => {
  let hash = (0x811c9dc5 + Math.imul(lane + 1, 0x9e3779b9)) >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  // FNV's low bits are deliberately cheap, but taking those bits modulo the
  // 31-character alphabet makes nearby lanes/seeds visibly correlated. A
  // final Murmur-style avalanche keeps every character independently spread
  // while remaining deterministic and available in browser test runners.
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b) >>> 0;
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35) >>> 0;
  hash ^= hash >>> 16;
  return hash >>> 0;
};

const deterministicUuid = (entity: ShortcodeEntity, seed: string): string => {
  const input = `${entity}\u0000${seed}`;
  const hex = [0, 1, 2, 3]
    .map((lane) => hashLane(input, lane).toString(16).padStart(8, "0"))
    .join("");
  const variant = (8 + (hashLane(input, 4) % 4)).toString(16);
  const versioned = `${hex.slice(0, 12)}4${hex.slice(13, 16)}${variant}${hex.slice(17)}`;
  return `${versioned.slice(0, 8)}-${versioned.slice(8, 12)}-${versioned.slice(
    12,
    16,
  )}-${versioned.slice(16, 20)}-${versioned.slice(20)}`;
};

const deterministicBody = (entity: ShortcodeEntity, seed: string): string => {
  const input = `${entity}\u0000${seed}`;
  return [0, 1, 2, 3]
    .map((lane) =>
      SHORTCODE_CHARS.charAt(hashLane(input, lane) % SHORTCODE_CHARS.length),
    )
    .join("");
};

/**
 * Make a deterministic, schema-validated UUIDv4 for a fabricated fixture.
 * Values returned by a database or resolver must be parsed with `parseEntityId`
 * instead; hashing a real value would silently change its identity.
 *
 * The entity is part of the hash namespace so the same seed can safely be used
 * for related fixtures without making their ids accidentally equal.
 */
export function testEntityId<E extends ShortcodeEntity>(
  entity: E,
  seed: string,
): EntityId<E> {
  try {
    // Exact UUID literals are useful in protocol/SQL expectation fixtures and
    // are already safe after schema validation. Other seeds are namespaced and
    // hashed so terse fixture labels remain valid UUIDv4 values.
    return parseEntityId(entity, seed);
  } catch {
    return parseEntityId(entity, deterministicUuid(entity, seed));
  }
}

/**
 * Make a deterministic, schema-validated public shortcode for a fabricated
 * fixture. Parse database or resolver values with `parseShortcodeFor` instead.
 */
export function testShortcode<E extends ShortcodeEntity>(
  entity: E,
  seed: string,
): ShortcodeFor<E> {
  try {
    // Preserve exact valid public identifiers so URL, display, and protocol
    // fixtures can assert their wire value. Non-code labels remain convenient
    // deterministic seeds.
    return parseShortcodeFor(entity, seed);
  } catch {
    // Fall through to a deterministic code in the entity's prefix namespace.
  }
  const code = `${SHORTCODE_PREFIX[entity]}${deterministicBody(entity, seed)}`;
  return parseShortcodeFor(entity, code);
}

/**
 * A fully-satisfied `DataQuality` block for fixtures that build a scored
 * entity's output but exercise nothing about data quality itself — every
 * `capabilities.dataQuality` entity's read shape requires the field.
 */
export function testCompleteDataQuality(): DataQuality {
  return {
    status: "complete",
    score: 100,
    facets: [],
    gaps: [],
    exceptions: [],
    relatedGaps: [],
    relatedExceptions: [],
  };
}
