import { describe, expect, it } from "vitest";
import { manifestFilterConfig } from "./filter-manifest";

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
    const injected = [{ value: "p1", label: "Kitchen" }];
    expect(
      manifestFilterConfig("purchase", "project", { project: injected })
        ?.options,
    ).toEqual(injected);
    // Absent injection yields an empty list, not the spec's static options.
    expect(manifestFilterConfig("purchase", "project")?.options).toEqual([]);
  });

  it("returns undefined for a column with no declared filter", () => {
    expect(manifestFilterConfig("purchase", "cost")).toBeUndefined();
  });
});
