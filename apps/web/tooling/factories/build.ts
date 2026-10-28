import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { entityKeys, entitySummary } from "@cubby/schemas/entity-summary";
import type { Faker } from "@faker-js/faker";
import { z } from "zod";

import { ENTITY_SCHEMA_BINDINGS } from "~/server/generated/entity-bindings.gen";

import { type Filler, fillerFor } from "./filler";

/**
 * One factory for every kernel-creatable entity, driven by the generated
 * `ENTITY_SCHEMA_BINDINGS`. The entity list and input types come from the
 * entity declarations' create schemas. Shared title filler follows the field
 * model; only concrete domain requirements need fixture defaults.
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
const DOMAIN_DEFAULTS = {
  recipe: () => ({ meta: null, sections: [] }),
  // Only a Product instance may omit the location type.
  location: () => ({ type: "room" }),
  inventory: () => ({ amount: { value: 1, unit: "each" } }),
  meal: () => ({ date: SOME_DAY }),
  ledgerParty: () => ({ kind: "guest" }),
  ledgerTransfer: () => ({ amount: 10, date: SOME_DAY }),
  purchase: () => ({ date: SOME_DAY }),
  financialAccount: () => ({ identity: { kind: "cash" } }),
  financialTransaction: () => ({
    kind: "purchase",
    status: "expected",
    amount: 10,
  }),
  // An absent trade is inherited; defaulting it would change that behavior.
  expense: () => ({
    lineKind: "principal",
    date: SOME_DAY,
    costType: "materials",
  }),
  gardenEntry: () => ({ observedOn: SOME_DAY }),
  device: () => ({ platform: "ios" }),
} satisfies {
  [E in CreatableEntity]?: (filler: Filler) => EntityOverrides<E>;
};

function creatableEntities(): CreatableEntity[] {
  return entityKeys.filter((entity): entity is CreatableEntity =>
    Object.entries(ENTITY_SCHEMA_BINDINGS).some(
      ([key, binding]) => key === entity && binding.createInput !== null,
    ),
  );
}
export const CREATABLE_ENTITIES = creatableEntities();

/** The un-parsed field bag: defaults first, then the caller's overrides. */
function entityDefaults<E extends CreatableEntity>(
  entity: E,
  opts: BuildOptions = {},
) {
  const filler = fillerFor(opts.faker);
  const summary = entitySummary[entity];
  const fields = entityFieldModels[entity].fields;
  const title = fields.find(
    (field) =>
      (field.key === summary.titleField || field.key === "name") &&
      field.kind === "text" &&
      entityFieldModels[entity].create.some((key) => key === field.key),
  );
  return {
    ...(title ? { [title.key]: filler.name(summary.singular) } : {}),
    ...Object.entries(DOMAIN_DEFAULTS).find(([key]) => key === entity)?.[1](),
  };
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
    Object.fromEntries(
      [entityDefaults(entity, opts), overrides].flatMap((record) =>
        // An undefined override is absent, so it must not erase a default.
        Object.entries(record).filter(([, value]) => value !== undefined),
      ),
    ),
  );
  if (!parsed.success) {
    throw new Error(
      `factory ${entity}: ${z.prettifyError(parsed.error)}\n(relations are never defaulted; pass them as overrides)`,
    );
  }
  // SAFETY: `schema` is this entity's own createInput, so its output is EntityInput<E>.
  return parsed.data as EntityInput<E>;
}
