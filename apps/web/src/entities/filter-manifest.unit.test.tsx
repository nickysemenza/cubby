import { describe, expect, it } from "vitest";
import { manifestFilterConfig } from "./filter-manifest";
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

  it("returns undefined for a column with no declared filter", () => {
    expect(manifestFilterConfig("purchase", "cost")).toBeUndefined();
  });
});
