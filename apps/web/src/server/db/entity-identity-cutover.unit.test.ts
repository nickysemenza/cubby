import { readFileSync } from "node:fs";

import {
  entityManifest,
  shortcodeEntities,
} from "@cubby/schemas/entity-manifest";
import { describe, expect, it } from "vitest";

import { entityIdentityTriggerSql } from "./entity-identity-schema";

const cutover = readFileSync(
  new URL(
    "../../../../../scripts/cutovers/entity-identity.sql",
    import.meta.url,
  ),
  "utf8",
);

// The production cutover is hand-run SQL; these keep it in step with the
// schema so a new shortcode entity or trigger change cannot ship without it.
describe("entity identity cutover", () => {
  it("installs exactly the triggers the test template installs", () => {
    expect(cutover).toContain(entityIdentityTriggerSql());
  });

  it("backfills and binds every shortcode table", () => {
    const missing = shortcodeEntities.flatMap((kind) => {
      const table = entityManifest[kind].dbTable;
      return cutover.includes(`SELECT "id", '${kind}', "shortcode"`) &&
        cutover.includes(`"${table}_entity_identity_fk"`)
        ? []
        : [kind];
    });
    expect(missing).toEqual([]);
  });
});
