import { entitySchema } from "@cubby/schemas/entity";
import { describe, expect, it } from "vitest";
import { getEntityFilters, manifestFilterConfig } from "./filter-manifest";
import { FILTER_ANY, FILTER_NONE } from "./filters";

/**
 * `manifestFilterConfig` is what tables that bypass `useStandardColumns` (the
 * embedded project-detail ones, via their column factories in
 * `app/projects/shared.tsx`) call to get the same control the index pages use.
 * These pin the pairs those factories look up, so the two surfaces can't
 * silently diverge back to single-select.
 */
describe("manifestFilterConfig", () => {
  it.each([
    ["task", "status"],
    ["task", "trade"],
    ["purchase", "trade"],
    ["purchase", "costType"],
  ] as const)("%s.%s is multiselect", (entity, columnId) => {
    expect(manifestFilterConfig(entity, columnId)?.filterType).toBe(
      "multiselect",
    );
  });

  it.each([
    // Complements — selecting both would mean "no filter".
    ["purchase", "product"],
    ["product", "ingredient"],
    // The cross-entity presence filters. These also pin the exact `columnId`
    // each one hangs on: a spec whose id matches no column renders NOTHING,
    // silently (the bug recorded on `task.dueDate` in the manifest).
    ["product", "purchases"],
    ["product", "food"],
    ["product", "image"],
    ["product", "unitMappingQuality"],
    ["location", "inventoryEntries"],
    ["ingredient", "appearsInRecipes"],
    ["recipe", "meals"],
    ["recipe", "image"],
    // A boolean, and a set of mutually exclusive windows.
    ["purchase", "future"],
    ["purchase", "date"],
  ] as const)("%s.%s stays single-select", (entity, columnId) => {
    expect(manifestFilterConfig(entity, columnId)?.filterType).toBe("select");
  });

  it("carries the options the control renders", () => {
    const config = manifestFilterConfig("purchase", "trade");
    expect(config?.options?.some((o) => o.value === "drywall")).toBe(true);
  });

  it("resolves a runtime picklist by key", () => {
    // `purchase.project` is a `nullable` spec, so its two sentinels
    // ("Has project" / "(none)") always lead the resolved options.
    const sentinels = [
      { value: FILTER_ANY, label: "Has project", meta: true },
      { value: FILTER_NONE, label: "(none)", meta: true },
    ];
    const injected = [{ value: "p1", label: "Kitchen" }];
    expect(
      manifestFilterConfig("purchase", "project", { project: injected })
        ?.options,
    ).toEqual([...sentinels, ...injected]);
    // Absent injection still yields the sentinels, not the spec's static
    // options — proves it doesn't fall back to `spec.options`.
    expect(manifestFilterConfig("purchase", "project")?.options).toEqual(
      sentinels,
    );
  });

  it("does not prepend sentinels to a non-nullable multiselect", () => {
    const options = manifestFilterConfig("purchase", "trade")?.options;
    expect(options?.some((o) => o.meta)).toBe(false);
  });

  it.each([
    ["recipe", "source", "cookbook"],
    ["location", "parent", "parent"],
  ] as const)(
    "%s.%s prepends (none) / Has %s sentinels",
    (entity, columnId, label) => {
      // Same shape as `purchase.project` above: the two sentinels always lead,
      // regardless of whether the runtime picklist (cookbook roster,
      // sibling locations) has been injected.
      expect(manifestFilterConfig(entity, columnId)?.options).toEqual([
        { value: FILTER_ANY, label: `Has ${label}`, meta: true },
        { value: FILTER_NONE, label: "(none)", meta: true },
      ]);
    },
  );

  it("returns undefined for a column with no declared filter", () => {
    // `cost` now HAS a spec (the presence filter added alongside this test) —
    // `createdAt` is a real purchases column that genuinely has none.
    expect(manifestFilterConfig("purchase", "createdAt")).toBeUndefined();
  });
});

/**
 * Locks the naming convention `buildFiltersFromManifest` depends on: a
 * `nullable.field` / a `presence` spec's server field must end in
 * `PresenceFilter`, or the sentinel-routing logic in `./filters` silently
 * writes to the wrong key. Loops the manifest's own entries so a newly added
 * spec is covered automatically, with no per-entity list to keep in sync.
 */
describe("manifest naming invariant", () => {
  it("every nullable.field and presence field ends in PresenceFilter", () => {
    const violations: string[] = [];
    for (const entity of entitySchema.options) {
      for (const spec of getEntityFilters(entity)) {
        if (spec.nullable && !spec.nullable.field.endsWith("PresenceFilter")) {
          violations.push(
            `${entity}.${spec.columnId}: nullable.field "${spec.nullable.field}"`,
          );
        }
        if (spec.kind === "presence") {
          const field = spec.field ?? spec.columnId;
          if (!field.endsWith("PresenceFilter")) {
            violations.push(`${entity}.${spec.columnId}: field "${field}"`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
