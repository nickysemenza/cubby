import { describe, expect, it } from "vitest";
import { projectSearchSchema } from "./projects.index";

describe("project route search validation", () => {
  it("accepts dashboard arrays and table comma-separated multi-filters", () => {
    expect(
      projectSearchSchema.parse({
        statuses: ["planning", "in_progress"],
        kinds: ["garden"],
        locations: ["home"],
      }),
    ).toMatchObject({
      statuses: ["planning", "in_progress"],
      kinds: ["garden"],
      locations: ["home"],
    });

    expect(
      projectSearchSchema.parse({
        statuses: "planning,in_progress",
        kinds: "garden,renovation",
        locations: "home,garage",
      }),
    ).toMatchObject({
      statuses: ["planning", "in_progress"],
      kinds: ["garden", "renovation"],
      locations: ["home", "garage"],
    });
  });

  it("accepts the two row renderers and drops anything else", () => {
    expect(projectSearchSchema.parse({ rows: "tree" })).toMatchObject({
      rows: "tree",
    });
    expect(projectSearchSchema.parse({ rows: "flat" })).toMatchObject({
      rows: "flat",
    });
    expect(projectSearchSchema.parse({ rows: "gantt" }).rows).toBeUndefined();
  });

  it("rejects invalid multi-filter values instead of widening the query", () => {
    expect(
      projectSearchSchema.safeParse({ statuses: "planning,not-a-status" })
        .success,
    ).toBe(false);
    expect(
      projectSearchSchema.safeParse({ kinds: ["garden", "not-a-kind"] })
        .success,
    ).toBe(false);
  });
});
