import { describe, expect, it } from "vitest";
import { problemQuery } from "~/entities/problem-registry";
import { problemWorklistState } from "./problem-worklist";

describe("problemWorklistState", () => {
  const query = problemQuery("productsMissingPrice");

  it("recognizes the exact filter and sort state without changing membership", () => {
    expect(query?.source.kind).toBe("entity");
    if (query?.source.kind !== "entity") return;

    expect(
      problemWorklistState(
        query.source.entity,
        query.key,
        [...query.source.filters],
        [...(query.source.sort ?? [])],
      ),
    ).toMatchObject({ exact: true, query });
  });

  it("retains source context but marks it modified after a filter edit", () => {
    expect(query?.source.kind).toBe("entity");
    if (query?.source.kind !== "entity") return;

    expect(
      problemWorklistState(query.source.entity, query.key, [], []),
    ).toMatchObject({ exact: false, query });
  });

  it("ignores a worklist that targets another entity", () => {
    expect(
      problemWorklistState("vendor", "productsMissingPrice", [], []),
    ).toBeUndefined();
  });
});
