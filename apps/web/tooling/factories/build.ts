import type { Faker } from "@faker-js/faker";
import { z } from "zod";

import { ENTITY_SCHEMA_BINDINGS } from "~/server/generated/entity-bindings.gen";

import { type Filler, fillerFor } from "./filler";

/**
 * One factory for every kernel-creatable entity, driven by the generated
 * `ENTITY_SCHEMA_BINDINGS`. The entity list and input types come from the
 * entity declarations' create schemas; the only hand-written part is
 * `ENTITY_DEFAULTS`, which a new creatable entity cannot omit (the table is
 * exhaustive, so a missing entry fails typecheck).
 *
 * A factory fills what a test does not care about. It does NOT invent a
 * relation: a foreign key is never defaulted, so a test that forgets
 * `productId` fails with the schema's own message rather than silently
 * attaching to a stranger's record.
 */

type Bindings = typeof ENTITY_SCHEMA_BINDINGS;

/** Entities whose declaration exposes a kernel create input. */
export type CreatableEntity = {
  [K in keyof Bindings]: Bindings[K]["createInput"] extends null ? never : K;
}[keyof Bindings];

type CreateSchema<E extends CreatableEntity> = NonNullable<
  Bindings[E]["createInput"]
>;
/** What a caller may pass: every field of the entity's create input, optional. */
export type EntityOverrides<E extends CreatableEntity> = Partial<
  z.input<CreateSchema<E>>
>;
/** The parsed create input, ready for the kernel or a repo writer. */
export type EntityInput<E extends CreatableEntity> = z.output<CreateSchema<E>>;

export interface BuildOptions {
  /** Seeded Faker for filler fields; omit for stable literal defaults. */
  faker?: Faker;
}

/** A date several specs and repo tests already treat as "some past day". */
const SOME_DAY = "2024-01-15";

/**
 * The fields a create input needs beyond what its schema defaults. Relations
 * (`vendorId`, `productId`, `accountId`, ...) and external identifiers
 * (`installationId`) are deliberately absent: the caller supplies them.
 */
const ENTITY_DEFAULTS = {
  product: (f) => ({ name: f.name("Product"), manufacturer: f.company() }),
  recipe: (f) => ({ name: f.name("Recipe"), meta: null, sections: [] }),
  ingredient: (f) => ({ name: f.name("Ingredient") }),
  // The kernel refuses a location with no type (only a Product instance may omit it).
  location: (f) => ({ name: f.name("Location"), type: "room" }),
  inventory: () => ({ amount: { value: 1, unit: "each" } }),
  meal: (f) => ({ name: f.name("Meal"), date: SOME_DAY }),
  ledgerParty: (f) => ({ name: f.name("Party"), kind: "guest" }),
  ledgerTransfer: () => ({ amount: 10, date: SOME_DAY }),
  project: (f) => ({ name: f.name("Project") }),
  task: (f) => ({ name: f.name("Task") }),
  vendor: (f) => ({ name: f.name("Vendor") }),
  purchase: () => ({ date: SOME_DAY }),
  financialAccount: (f) => ({
    name: f.name("Account"),
    identity: { kind: "cash" },
  }),
  financialTransaction: () => ({
    kind: "purchase",
    status: "expected",
    amount: 10,
  }),
  wish: (f) => ({ name: f.name("Wish") }),
  // `trade` and `cost` stay unset on purpose: an absent trade is inherited from
  // the project/purchase, and a default would silently break that.
  expense: (f) => ({
    name: f.name("Expense"),
    date: SOME_DAY,
    costType: "materials",
  }),
  planting: () => ({}),
  gardenEntry: () => ({ observedOn: SOME_DAY }),
  vendorAccount: (f) => ({ label: f.name("Account") }),
  productCategory: (f) => ({ name: f.name("Category") }),
  device: (f) => ({ name: f.name("Device"), platform: "ios" }),
  plant: (f) => ({ name: f.name("Plant") }),
  spendingCategory: (f) => ({ name: f.name("Spending") }),
} satisfies {
  [E in CreatableEntity]: (filler: Filler) => EntityOverrides<E>;
};

function creatableEntities(): CreatableEntity[] {
  // SAFETY: `satisfies` above makes ENTITY_DEFAULTS keyed exactly by CreatableEntity.
  return Object.keys(ENTITY_DEFAULTS) as CreatableEntity[];
}
export const CREATABLE_ENTITIES = creatableEntities();

/**
 * `undefined` means "not provided", as it does in the optional-argument
 * seeders (`dueDate: opts.dueDate`). A bare spread would let it erase a default.
 */
const definedEntries = <E extends CreatableEntity>(
  record: EntityOverrides<E>,
): [string, unknown][] =>
  Object.entries(record).filter(([, value]) => value !== undefined);

/** The un-parsed field bag: defaults first, then the caller's overrides. */
function entityDefaults<E extends CreatableEntity>(
  entity: E,
  opts: BuildOptions = {},
): EntityOverrides<E> {
  // SAFETY: each ENTITY_DEFAULTS entry is typed for its own entity key.
  return ENTITY_DEFAULTS[entity](fillerFor(opts.faker)) as EntityOverrides<E>;
}

/** Build a parsed create input: defaults, then overrides, through the entity's own schema. */
export function buildEntity<E extends CreatableEntity>(
  entity: E,
  overrides: EntityOverrides<E> = {},
  opts: BuildOptions = {},
): EntityInput<E> {
  const schema = ENTITY_SCHEMA_BINDINGS[entity].createInput;
  if (!schema) throw new Error(`factory ${entity}: no create input`);
  const parsed = schema.safeParse(
    Object.fromEntries([
      ...definedEntries(entityDefaults(entity, opts)),
      ...definedEntries(overrides),
    ]),
  );
  if (!parsed.success) {
    throw new Error(
      `factory ${entity}: ${z.prettifyError(parsed.error)}\n(relations are never defaulted; pass them as overrides)`,
    );
  }
  // SAFETY: `schema` is this entity's own createInput, so its output is EntityInput<E>.
  return parsed.data as EntityInput<E>;
}
