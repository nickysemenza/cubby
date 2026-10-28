import { describe, expect, it } from "vitest";

import { problemQuery } from "~/entity/problems/problem-registry";

import { problemWorklistState } from "./problem-worklist";

describe("problemWorklistState", () => {
  const query = problemQuery("productsMissingPrice");
  const continuation =
    query?.source.kind === "entity"
      ? { key: query.key, title: query.title, source: query.source }
      : null;

  it("recognizes the exact filter and sort state without changing membership", () => {
    expect(query?.source.kind).toBe("entity");
    if (query?.source.kind !== "entity") return;

    expect(
      problemWorklistState(
        query.source.entity,
        continuation,
        [...query.source.filters],
        [...(query.source.sort ?? [])],
      ),
    ).toMatchObject({ exact: true, query: continuation });
  });

  it("retains source context but marks it modified after a filter edit", () => {
    expect(query?.source.kind).toBe("entity");
    if (query?.source.kind !== "entity") return;

    expect(
      problemWorklistState(query.source.entity, continuation, [], []),
    ).toMatchObject({ exact: false, query: continuation });
  });

  it("ignores a worklist that targets another entity", () => {
    expect(
      problemWorklistState(
        "vendor",
        query?.source.kind === "entity"
          ? { key: query.key, title: query.title, source: query.source }
          : null,
        [],
        [],
      ),
    ).toBeUndefined();
  });
});
