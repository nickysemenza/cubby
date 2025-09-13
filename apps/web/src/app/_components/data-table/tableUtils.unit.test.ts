import { expect, test, describe } from "vitest";
import {
  buildSortParams,
  defaultPagination,
  defaultSortState,
} from "./tableUtils";
import { type SortingState } from "@tanstack/react-table";

describe("buildSortParams", () => {
  test("returns correct params with sorting state", () => {
    const sorting: SortingState = [{ id: "name", desc: true }];
    const result = buildSortParams(sorting);

    expect(result).toEqual({
      direction: "desc",
      orderBy: "name",
    });
  });

  test("returns correct params with sorting state in ascending order", () => {
    const sorting: SortingState = [{ id: "name", desc: false }];
    const result = buildSortParams(sorting);

    expect(result).toEqual({
      direction: "asc",
      orderBy: "name",
    });
  });

  test("uses initialSort when sorting state is empty", () => {
    const sorting: SortingState = [];
    const result = buildSortParams(sorting, "title");

    expect(result).toEqual({
      direction: "asc",
      orderBy: "title",
    });
  });

  test("uses createdAt as default when sorting state is empty and no initialSort", () => {
    const sorting: SortingState = [];
    const result = buildSortParams(sorting);

    expect(result).toEqual({
      direction: "asc",
      orderBy: "createdAt",
    });
  });
});

describe("defaultSortState", () => {
  test("returns correct default state with initialSort", () => {
    const result = defaultSortState("name");

    expect(result).toEqual([{ id: "name", desc: true }]);
  });

  test("returns correct default state without initialSort", () => {
    const result = defaultSortState();

    expect(result).toEqual([{ id: "createdAt", desc: true }]);
  });
});

describe("defaultPagination", () => {
  test("has correct default values", () => {
    expect(defaultPagination).toEqual({
      pageIndex: 0,
      pageSize: 10,
    });
  });
});
