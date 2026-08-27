import { AppErrors } from "@cubby/shared";
import { describe, expect, expectTypeOf, it } from "vitest";
import { type ShortcodeEntity, shortcodeEntities } from "./entity-manifest";
import { entityNames } from "./generated/entity-names.gen";
import {
  ENTITY_ID_SCHEMA,
  ENTITY_LABEL,
  ENTITY_NOT_FOUND_REASON,
  type EntityId,
  type EntityRef,
  type FinancialAccountId,
  type InventoryId,
  type ProductId,
  entityIdSchema,
  parseEntityId,
  parseEntityRef,
} from "./identifiers";

const sorted = (xs: readonly string[]) => [...xs].sort();

const UUID = "3f7c1a52-9d0b-4e21-8b6a-1c2d3e4f5a6b";

/**
 * The generic shape both lookups exist to enable: an entity known only as a
 * value, turned into that entity's branded id. This is what a shared
 * `resolveOrThrow(db, entity, code)` will be built on, so exercising it here
 * proves the maps are usable with an UNRESOLVED `E`, not just with literals.
 */
const parseFor = <E extends ShortcodeEntity>(
  entity: E,
  value: unknown,
): EntityId<E> => parseEntityId(entity, value);

describe("entity id lookups", () => {
  it("covers every shortcode entity in every lookup", () => {
    // Drift guard. Adding an entity to the manifest without adding it here is
    // already a compile error (`ENTITY_ID_SCHEMA` is a mapped type over
    // `ShortcodeEntity`; `ENTITY_NOT_FOUND_REASON` `satisfies` a Record over
    // it), so this asserts the runtime maps too — no extra keys, none dropped.
    expect(sorted(Object.keys(ENTITY_ID_SCHEMA))).toEqual(
      sorted(shortcodeEntities),
    );
    expect(sorted(Object.keys(ENTITY_NOT_FOUND_REASON))).toEqual(
      sorted(shortcodeEntities),
    );
    expect(sorted(Object.keys(ENTITY_LABEL))).toEqual(
      sorted(shortcodeEntities),
    );
  });

  it("labels every entity the way its existing messages already do", () => {
    // These strings go straight into user-facing not-found errors, so they must
    // read as the start of a sentence — and match what the hand-rolled lookups
    // they replace already threw, so consolidating reworded nothing (except
    // `inventory`: it was consolidated as "Inventory entry", but the client's
    // registry label, its route not-found copy, and the manifest's own
    // `names.singular` all already said "item" — a genuine word-choice drift
    // fixed here, not a casing one; see the `ENTITY_LABEL` doc comment).
    expect(ENTITY_LABEL.inventory).toBe("Inventory item");
    expect(ENTITY_LABEL.financialAccount).toBe("Financial account");
    expect(ENTITY_LABEL.financialTransaction).toBe("Financial transaction");

    for (const entity of shortcodeEntities) {
      const label = ENTITY_LABEL[entity];
      expect(label).toMatch(/^[A-Z]/);
      // Sentence case, not Title Case: "Financial account", never "Financial
      // Account" — the label is only ever used sentence-initially.
      expect(label).toBe(
        label.charAt(0) + label.slice(1).toLowerCase().replace(/_/g, " "),
      );
      // ...and it is that one canonical name, not a second copy of it: the
      // value is the entity literal's `names.singular` with everything after
      // the first word lowered, so a manifest rename reaches server prose.
      expect(label.toLowerCase()).toBe(
        entityNames[entity].singular.toLowerCase(),
      );
    }
  });

  it("maps every entity to a real NOT_FOUND reason", () => {
    for (const entity of shortcodeEntities) {
      const reason = ENTITY_NOT_FOUND_REASON[entity];
      expect(Object.keys(AppErrors)).toContain(reason);
      expect(AppErrors[reason]).toBe("NOT_FOUND");
    }
  });

  it("keeps the three reasons a derived key would get wrong", () => {
    expect(ENTITY_NOT_FOUND_REASON.inventory).toBe("INVENTORY_NOT_FOUND");
    expect(ENTITY_NOT_FOUND_REASON.financialAccount).toBe(
      "FINANCIAL_ACCOUNT_NOT_FOUND",
    );
    expect(ENTITY_NOT_FOUND_REASON.financialTransaction).toBe(
      "FINANCIAL_TRANSACTION_NOT_FOUND",
    );
    for (const entity of shortcodeEntities) {
      const derived = `${entity.toUpperCase()}_NOT_FOUND`;
      if (derived !== ENTITY_NOT_FOUND_REASON[entity]) {
        expect(Object.keys(AppErrors)).not.toContain(derived);
      }
    }
  });

  it("brands by entity, at the type level", () => {
    expectTypeOf(parseFor("product", UUID)).toEqualTypeOf<ProductId>();
    expectTypeOf(parseFor("inventory", UUID)).toEqualTypeOf<InventoryId>();
    expectTypeOf(
      parseFor("financialAccount", UUID),
    ).toEqualTypeOf<FinancialAccountId>();
    expectTypeOf<EntityId<"product">>().toEqualTypeOf<ProductId>();
    expectTypeOf<EntityId<"inventory">>().toEqualTypeOf<InventoryId>();

    // Parsing validates without changing a valid UUID's value.
    for (const entity of shortcodeEntities) {
      expect(parseEntityId(entity, UUID)).toBe(UUID);
    }
  });

  it("rejects malformed ids through every entity schema", () => {
    for (const entity of shortcodeEntities) {
      expect(entityIdSchema(entity).safeParse("not-a-uuid").success).toBe(
        false,
      );
    }
  });

  it("correlates an entity reference's discriminator with its id brand", () => {
    const ref: EntityRef = parseEntityRef("product", UUID);
    if (ref.entity === "product") {
      expectTypeOf(ref.id).toEqualTypeOf<ProductId>();
    }
  });
});
