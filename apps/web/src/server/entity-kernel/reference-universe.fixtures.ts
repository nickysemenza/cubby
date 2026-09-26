/**
 * A small real reference universe for kernel-wide integration matrices: one
 * seeded row of every kernel-creatable entity, in dependency order, with
 * every shortcode reference patched onto a real seeded row. Shared by the
 * list smoke matrix and the delete-policy matrix.
 */
import { testUserId } from "@cubby/schemas/testing";
import {
  seedEntity,
  TEST_HOME_SHORTCODE,
  TEST_USER_ID,
} from "tooling/test-setup";

import { mock } from "~/lib/test/mock-schema";
import type { Database } from "~/server/db";
import { ENTITY_KERNEL_ENTITIES } from "~/server/entity-kernel/contracts";
import type { EntityKernelEntity } from "~/server/entity-kernel/contracts";
import { ENTITY_KERNEL_BINDINGS } from "~/server/generated/entity-kernel-bindings.gen";
import { createImageFixture } from "~/server/repo/repo.fixtures";
import { requireActor } from "~/server/request-context";
import { createTestRequestContext } from "~/server/testing/request-context";

// Entities the kernel cannot create through `seedEntity` (createInput is
// `null` — see `entity-bindings.gen.ts`). Their list surface is still
// exercised below; only the seed step is skipped. A `Map` rather than a
// dictionary object, since only entity keys that actually opt out belong
// here.
export const SKIPPED_ENTITIES = new Map<EntityKernelEntity, string>([
  [
    "image",
    "createInput is null — image creation is an upload workflow, not a kernel create",
  ],
]);

export type JsonPath = Array<string | number>;

export const SHORTCODE_PATTERN = /^[A-Z]{2,}-[A-Za-z0-9]+$/;
export const prefixOf = (code: string): string | undefined =>
  /^([A-Z]{2,}-)/.exec(code)?.[1];

/**
 * `mock()` walks an arbitrary Zod schema and its output shape is therefore
 * genuinely heterogeneous by construction — every declared filter/createInput
 * schema in the entity roster shapes it differently, so there is no single
 * concrete domain type to assign it ahead of time. This block is the one
 * generic reflection layer that walks and rebuilds that data (path
 * collection, in-place patching, and integer rounding); everywhere else in
 * this file works with concrete, named types. Mirrors the same trade-off
 * `packages/schemas/src/entity-definitions/definition.ts`'s
 * `valueIsMissingAt` parser-boundary walker makes for the same reason.
 */
/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type -- see block comment above */

/** Walk any mock()-generated value, reporting every shortcode-shaped string. */
export function collectShortcodePaths(
  value: unknown,
  path: JsonPath,
  out: Array<{ path: JsonPath; code: string }>,
): void {
  if (typeof value === "string") {
    if (SHORTCODE_PATTERN.test(value)) out.push({ path, code: value });
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries())
      collectShortcodePaths(item, [...path, index], out);
    return;
  }
  if (value !== null && typeof value === "object" && !(value instanceof Date)) {
    for (const [key, item] of Object.entries(value))
      collectShortcodePaths(item, [...path, key], out);
  }
}

export function setAtPath(
  target: Record<string, unknown>,
  path: JsonPath,
  value: unknown,
): void {
  let cursor: Record<string, unknown> = target;
  for (let i = 0; i < path.length - 1; i++) {
    const key = String(path[i]);
    const next = path[i + 1];
    const existing = cursor[key];
    if (existing === null || typeof existing !== "object")
      cursor[key] = typeof next === "number" ? [] : {};
    // SAFETY: the branch above just assigned an array or a plain object when
    // `cursor[key]` wasn't already one, so it is always walkable here.
    cursor = cursor[key] as Record<string, unknown>;
  }
  const lastKey = path.at(-1);
  if (lastKey !== undefined) cursor[String(lastKey)] = value;
}
/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type */

/**
 * Drizzle wraps the real Postgres error (e.g. `invalid reference to
 * FROM-clause entry for table "X"`) as `.cause` under a generic "Failed
 * query" message — surface both so a failure names the actual SQL problem.
 * `TCaught` (not an `unknown` parameter) matches how a caught value's type
 * arrives at this boundary: whatever the try block threw.
 */
export function describeError<TCaught>(err: TCaught): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause instanceof Error ? err.cause.message : undefined;
  // Drizzle's own message embeds the full query text (hundreds of lines for
  // an inherited-column list); the Postgres cause is the one-line diagnosis.
  const summary =
    err.message.length > 200 ? `${err.message.slice(0, 200)}…` : err.message;
  return cause ? `${cause} (${summary})` : summary;
}

/**
 * Probe an entity's createInput once to discover which required fields are
 * shortcode references, and patch them onto REAL seeded shortcodes. `mock()`
 * always resolves a bare `.union()` to its first option and omits
 * `.optional()` fields deterministically (see mock-schema.ts's header), so
 * the set of keys this probe finds is stable across the later real call
 * `seedEntity` makes with these overrides layered on top of a fresh sample.
 */
function buildReferenceOverrides(
  entity: EntityKernelEntity,
  shortcodeByPrefix: ReadonlyMap<string, string>,
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- see the walker block comment above
): Record<string, unknown> {
  const schema = ENTITY_KERNEL_BINDINGS[entity].schemas.createInput;
  if (!schema) return {};
  let probe: unknown;
  try {
    probe = mock(schema, { seed: 909 });
  } catch {
    return {};
  }
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- see the walker block comment above
  const overrides: Record<string, unknown> = {};
  const found: Array<{ path: JsonPath; code: string }> = [];
  collectShortcodePaths(probe, [], found);
  for (const { path, code } of found) {
    const prefix = prefixOf(code);
    const real = prefix ? shortcodeByPrefix.get(prefix) : undefined;
    if (real) setAtPath(overrides, path, real);
  }
  // oxlint-disable-next-line anti-slop/no-known-value-widening -- see the walker block comment above
  return overrides;
}

export interface ReferenceUniverse {
  shortcodeByPrefix: Map<string, string>;
  skippedEntities: Array<{ entity: EntityKernelEntity; reason: string }>;
}

/**
 * Seed one row of every kernel-creatable entity, in dependency order, so
 * every declared filter/sort has a real shortcode to resolve against.
 * Explicit overrides beyond the generic reference-patching above are only
 * the links the known bug instances specifically exercise (expense.trade,
 * gardenEntry -> planting) or that a create schema leaves optional and would
 * otherwise omit (task/planting/inventory/gardenEntry location and product
 * links) — everything else is discovered generically from each entity's own
 * createInput shape.
 */
export async function seedReferenceUniverse(
  db: Database,
): Promise<ReferenceUniverse> {
  const shortcodeByPrefix = new Map<string, string>([
    ["LOC-", TEST_HOME_SHORTCODE],
  ]);
  const skippedEntities: Array<{ entity: EntityKernelEntity; reason: string }> =
    [];

  const record = (shortcode: string) => {
    const prefix = prefixOf(shortcode);
    if (prefix) shortcodeByPrefix.set(prefix, shortcode);
  };

  const seed = async <E extends EntityKernelEntity>(
    entity: E,
    // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- see the walker block comment above
    extraOverrides: Record<string, unknown> = {},
  ) => {
    const skipReason = SKIPPED_ENTITIES.get(entity);
    if (skipReason) {
      skippedEntities.push({ entity, reason: skipReason });
      return null;
    }
    const overrides = {
      ...buildReferenceOverrides(entity, shortcodeByPrefix),
      ...extraOverrides,
    };
    // SAFETY: `overrides` is a sparse patch keyed by the entity's own
    // createInput shape (see buildReferenceOverrides); seedEntity/mock()
    // merges it against a freshly generated sample and re-validates through
    // the entity's real createInput schema before the kernel ever sees it.
    const created = await seedEntity(db, entity, overrides as never);
    record(created.id);
    return created;
  };

  await seed("product");
  const project = await seed("project");
  await seed("vendor");
  await seed("ingredient");
  // Before planting: a planting's required plantId resolves through it.
  await seed("plant");
  const purchase = await seed("purchase");

  // oxlint-disable-next-line anti-slop/no-known-value-widening, anti-slop/no-unsafe-dictionary-type -- see the walker block comment above
  const expenseOverrides: Record<string, unknown> = {
    trade: "drywall",
    date: "2024-01-15",
  };
  if (project) expenseOverrides.projectId = project.id;
  if (purchase) expenseOverrides.purchaseId = purchase.id;
  await seed("expense", expenseOverrides);

  // oxlint-disable-next-line anti-slop/no-known-value-widening, anti-slop/no-unsafe-dictionary-type -- see the walker block comment above
  const taskOverrides: Record<string, unknown> = { trade: "drywall" };
  if (project) taskOverrides.projectId = project.id;
  await seed("task", taskOverrides);

  const planting = await seed("planting", { locationId: TEST_HOME_SHORTCODE });
  if (!planting)
    throw new Error(
      "list-smoke: planting must seed for gardenEntry.plantingId coverage",
    );
  await seed("gardenEntry", {
    plantingIds: [planting.id],
    locationId: TEST_HOME_SHORTCODE,
  });

  // Inventory cannot sit directly on the house-type root — give it a real
  // storage location underneath Home.
  const storageLocation = await seed("location", {
    parentId: TEST_HOME_SHORTCODE,
    type: "shelf",
  });
  await seed("inventory", {
    locationId: storageLocation ? storageLocation.id : TEST_HOME_SHORTCODE,
  });

  await seed("recipe");
  await seed("meal");
  await seed("wish");
  const ledgerPartyA = await seed("ledgerParty");
  const ledgerPartyB = await seed("ledgerParty");
  if (ledgerPartyB) record(ledgerPartyB.id);

  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- see the walker block comment above
  const financialAccountOverrides: Record<string, unknown> = {};
  if (ledgerPartyA) financialAccountOverrides.ledgerPartyId = ledgerPartyA.id;
  const financialAccount = await seed(
    "financialAccount",
    financialAccountOverrides,
  );

  // `financialTransactionCreateInput` cross-field-refines status/postedDate
  // and purchaseId/allocations coherence; a plain unseeded mock() sample can
  // fail those refinements outright (its own randomly-picked "posted" status
  // needs a postedDate), which makes `buildReferenceOverrides`'s probe throw
  // and silently return no overrides. Pin a combination the refinements
  // accept instead of relying on generic discovery for this one entity.
  // oxlint-disable-next-line anti-slop/no-known-value-widening, anti-slop/no-unsafe-dictionary-type -- see the walker block comment above
  const financialTransactionOverrides: Record<string, unknown> = {
    status: "pending",
  };
  if (financialAccount)
    financialTransactionOverrides.accountId = financialAccount.id;
  await seed("financialTransaction", financialTransactionOverrides);

  await seed("productCategory");
  await seed("vendorAccount");

  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- see the walker block comment above
  const ledgerTransferOverrides: Record<string, unknown> = {};
  if (ledgerPartyA) ledgerTransferOverrides.fromPartyId = ledgerPartyA.id;
  if (ledgerPartyB) ledgerTransferOverrides.toPartyId = ledgerPartyB.id;
  await seed("ledgerTransfer", ledgerTransferOverrides);

  // `image` has no kernel create (see SKIPPED_ENTITIES), but a sighting
  // needs one; insert it directly so imageSighting's filters are guarded.
  const image = await createImageFixture(db, "list-smoke");
  record(image.shortcode);
  const device = await seed("device");
  // oxlint-disable-next-line anti-slop/no-known-value-widening, anti-slop/no-unsafe-dictionary-type -- see the walker block comment above
  const sightingOverrides: Record<string, unknown> = {
    imageId: image.shortcode,
  };
  if (device) sightingOverrides.deviceId = device.id;
  if (ledgerPartyA) sightingOverrides.ledgerPartyId = ledgerPartyA.id;
  await seed("imageSighting", sightingOverrides);

  // `image` (and any other entity this sequence never attempted) still needs
  // to be recorded as skipped for the report below.
  for (const entity of ENTITY_KERNEL_ENTITIES) {
    const reason = SKIPPED_ENTITIES.get(entity);
    if (reason && !skippedEntities.some((s) => s.entity === entity))
      skippedEntities.push({ entity, reason });
  }

  return { shortcodeByPrefix, skippedEntities };
}

export function buildKernelContext(db: Database) {
  const base = createTestRequestContext(db, {
    auth: { userId: testUserId(TEST_USER_ID) },
  });
  return requireActor(base);
}
