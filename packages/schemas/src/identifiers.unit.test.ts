import { AppErrors } from "@cubby/shared";
import { describe, expect, it } from "vitest";
import { shortcodeEntities } from "./entity-manifest";
import { entitySummary } from "./generated/entity-summary.gen";
import {
  ENTITY_LABEL,
  ENTITY_NOT_FOUND_REASON,
  entityIdSchema,
  parseEntityId,
} from "./identifiers";

const UUID = "3f7c1a52-9d0b-4e21-8b6a-1c2d3e4f5a6b";

describe("entity id lookups", () => {
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
        entitySummary[entity].singular.toLowerCase(),
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
        // oxlint-disable-next-line vitest/no-conditional-expect -- The data-dependent branch determines whether this optional case is applicable.
        expect(Object.keys(AppErrors)).not.toContain(derived);
      }
    }
  });

  it("preserves valid UUID values for every entity", () => {
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
});
