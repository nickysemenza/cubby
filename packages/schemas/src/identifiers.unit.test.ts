import { AppErrors } from "@cubby/shared";
import { describe, expect, expectTypeOf, it } from "vitest";
import { type ShortcodeEntity, shortcodeEntities } from "./entity-manifest";
import {
  type BrandForEntity,
  ENTITY_LABEL,
  ENTITY_NOT_FOUND_REASON,
  type FinancialAccountId,
  type InventoryId,
  type ProductId,
  unsafeIdForEntity,
  unsafeProductId,
} from "./identifiers";

const sorted = (xs: readonly string[]) => [...xs].sort();

const UUID = "3f7c1a52-9d0b-4e21-8b6a-1c2d3e4f5a6b";

/**
 * The generic shape both lookups exist to enable: an entity known only as a
 * value, turned into that entity's branded id. This is what a shared
 * `resolveOrThrow(db, entity, code)` will be built on, so exercising it here
 * proves the maps are usable with an UNRESOLVED `E`, not just with literals.
 */
const brandFor = <E extends ShortcodeEntity>(
  entity: E,
  id: string,
): BrandForEntity<E> => unsafeIdForEntity[entity](id);

describe("entity id lookups", () => {
  it("covers every shortcode entity, in both lookups", () => {
    // Drift guard. Adding an entity to the manifest without adding it here is
    // already a compile error (`unsafeIdForEntity` is a mapped type over
    // `ShortcodeEntity`; `ENTITY_NOT_FOUND_REASON` `satisfies` a Record over
    // it), so this asserts the runtime maps too — no extra keys, none dropped.
    expect(sorted(Object.keys(unsafeIdForEntity))).toEqual(
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
    // they replace already threw, so consolidating reworded nothing.
    expect(ENTITY_LABEL.inventory).toBe("Inventory entry");
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
    expectTypeOf(brandFor("product", UUID)).toEqualTypeOf<ProductId>();
    expectTypeOf(brandFor("inventory", UUID)).toEqualTypeOf<InventoryId>();
    expectTypeOf(
      brandFor("financialAccount", UUID),
    ).toEqualTypeOf<FinancialAccountId>();
    expectTypeOf<BrandForEntity<"product">>().toEqualTypeOf<ProductId>();
    expectTypeOf<BrandForEntity<"inventory">>().toEqualTypeOf<InventoryId>();

    // A brand is a compile-time-only tag: the value must survive untouched, or
    // the id that reaches the DB would no longer be the one that was resolved.
    for (const entity of shortcodeEntities) {
      expect(unsafeIdForEntity[entity](UUID)).toBe(UUID);
    }
  });

  it("still rejects an already-branded value", () => {
    const branded = unsafeProductId(UUID);
    // Going through the map must not widen the parameter to `string` — that
    // would quietly re-admit the no-op casts the hand-written `unsafe*Id`
    // guards reject. (`@ts-expect-error` fails the build if this ever compiles.)
    // @ts-expect-error — `branded` is already a ProductId; brand upstream instead.
    expect(unsafeIdForEntity.product(branded)).toBe(UUID);
  });
});
