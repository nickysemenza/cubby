import type { SortingState } from "@tanstack/react-table";
import { describe, expect, it } from "vitest";

import { buildSortParams, defaultSortState } from "./tableUtils";

describe("buildSortParams", () => {
  it("returns correct params with sorting state", () => {
    const sorting: SortingState = [{ id: "name", desc: true }];
    const result = buildSortParams(sorting);

    expect(result).toEqual({
      direction: "desc",
      orderBy: "name",
    });
  });

  it("returns correct params with sorting state in ascending order", () => {
    const sorting: SortingState = [{ id: "name", desc: false }];
    const result = buildSortParams(sorting);

    expect(result).toEqual({
      direction: "asc",
      orderBy: "name",
    });
  });

  it("uses initialSort when sorting state is empty", () => {
    const sorting: SortingState = [];
    const result = buildSortParams(sorting, "title");

    expect(result).toEqual({
      direction: "asc",
      orderBy: "title",
    });
  });

  it("uses createdAt as default when sorting state is empty and no initialSort", () => {
    const sorting: SortingState = [];
    const result = buildSortParams(sorting);

    expect(result).toEqual({
      direction: "asc",
      orderBy: "createdAt",
    });
  });
});

describe("defaultSortState", () => {
  it("returns correct default state with initialSort", () => {
    const result = defaultSortState("name");

    expect(result).toEqual([{ id: "name", desc: true }]);
  });

  it("returns correct default state without initialSort", () => {
    const result = defaultSortState();

    expect(result).toEqual([{ id: "createdAt", desc: true }]);
  });
});
