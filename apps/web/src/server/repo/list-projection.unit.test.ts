import { describe, expect, it } from "vitest";

import { expandListGroups, loadListGroup } from "./list-projection";

describe("list projection group execution", () => {
  // A selected consumer must include transitive dependencies once, before its
  // own group. A cycle must fail rather than recurse indefinitely.
  it("expands transitive loader dependencies in order, deduplicating repeated consumers", () => {
    expect(
      expandListGroups(["derived", "media", "derived"], {
        derived: ["relations"],
        relations: ["quality"],
        media: ["relations"],
      }),
    ).toEqual(["quality", "relations", "derived", "media"]);
    expect(expandListGroups([], { derived: ["relations"] })).toEqual([]);
    expect(() =>
      expandListGroups(["derived"], {
        derived: ["relations"],
        relations: ["derived"],
      }),
    ).toThrow("dependency cycle");
  });

  // Shared dependencies must execute once, and omitted groups must perform no
  // work: either failure adds database reads to progressive list requests.
  it("loads a shared relation dependency once without running omitted quality work", async () => {
    const projection = {
      kind: "enrichment" as const,
      groups: ["derived" as const],
    };
    const executed: string[] = [];
    const [relations, quality] = await Promise.all([
      loadListGroup(projection, ["relations", "derived"], async () => {
        executed.push("relations");
        return new Map([
          ["synthetic", { name: "Synthetic relation", count: 2 }],
        ]);
      }),
      loadListGroup(projection, "quality", async () => {
        executed.push("quality");
        throw new Error("Unrequested quality must not execute");
      }),
    ]);

    expect(relations?.get("synthetic")).toEqual({
      name: "Synthetic relation",
      count: 2,
    });
    expect(quality).toBeUndefined();
    expect(executed).toEqual(["relations"]);
  });

  it("executes no enrichment for base and all registered loaders for full", async () => {
    let executions = 0;
    const load = async () => ++executions;
    expect(
      await loadListGroup({ kind: "base" }, "relations", load),
    ).toBeUndefined();
    expect(
      await loadListGroup({ kind: "full" }, ["relations", "derived"], load),
    ).toBe(1);
    expect(executions).toBe(1);
  });
});
