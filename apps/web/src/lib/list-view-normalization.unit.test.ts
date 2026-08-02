import { describe, expect, it } from "vitest";
import {
  isValidProjectDateFilter,
  isValidTaskStatusFilter,
  normalizeProjectRenderer,
  normalizeTaskRenderer,
} from "./list-view-normalization";

describe("legacy list-view normalization", () => {
  it("keeps bare projects unrestricted", () => {
    expect(normalizeProjectRenderer(undefined)).toEqual({ view: undefined });
  });

  it("turns project History into Data plus Completed", () => {
    expect(normalizeProjectRenderer("history")).toEqual({
      view: "data",
      statuses: ["done"],
    });
  });

  it("normalizes the retired task renderer names", () => {
    expect(normalizeTaskRenderer("history")).toEqual({
      view: "list",
      status: "done",
    });
    expect(normalizeTaskRenderer("inbox")).toEqual({
      view: "list",
      status: "not_started,later,in_progress,blocked",
      project: "__none__",
      parentTask: "__none__",
    });
    expect(normalizeTaskRenderer("all")).toEqual({
      view: "list",
      clearFilters: true,
    });
  });

  it("rejects invalid date and status declarations", () => {
    expect(isValidProjectDateFilter("2024")).toBe(true);
    expect(isValidProjectDateFilter("bogus")).toBe(false);
    expect(isValidTaskStatusFilter("not_started,blocked")).toBe(true);
    expect(isValidTaskStatusFilter("bogus")).toBe(false);
  });
});
