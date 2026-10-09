import { shortcodeEntities } from "@cubby/schemas/entity-index";
import { ENTITY_LABEL } from "@cubby/schemas/identifiers";
import { describe, expect, it } from "vitest";

import { entityLabel, isBrowserRoutedEntity } from "./entities";

describe("entity label parity", () => {
  it("title-cases ENTITY_LABEL for every shortcode entity with a browser route", () => {
    // Drift guard: `ENTITY_LABEL` (`@cubby/schemas/identifiers`, server error
    // prose, sentence case) and this registry's `.label` (UI chrome — nav,
    // headers, dialog titles — Title Case) used to be two hand-maintained
    // maps that could silently disagree, as "Inventory entry" vs. "Inventory
    // Item" once did. Both now come from the same manifest declaration, so a
    // mismatch here means one of the two derivations broke or a `label` went
    // back to being hand-typed. Re-implements the casing independently of
    // `entities.tsx` so the assertion isn't a tautology against its helper.
    const titleCase = (label: string): string =>
      label
        .split(" ")
        .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
        .join(" ");

    const covered = shortcodeEntities.filter((entity) =>
      isBrowserRoutedEntity(entity),
    );
    // Sanity check the guard itself isn't vacuous: every shortcode entity has
    // a browser route today — `ledgerParty`/`ledgerTransfer` were the last
    // holdouts.
    expect(covered.length).toBe(shortcodeEntities.length);

    for (const entity of covered) {
      expect(entityLabel(entity)).toBe(titleCase(ENTITY_LABEL[entity]));
    }
  });
});
