import { describe, expect, it } from "vitest";
import { projectDateDelta } from "./project-formatting";

describe("projectDateDelta", () => {
  it("returns null when the override matches the derived bound", () => {
    expect(projectDateDelta("end", "2020-08-10", "2020-08-10")).toBeNull();
  });

  it("reads an end override past the last dated work as slack, not drift", () => {
    const delta = projectDateDelta("end", "2020-08-10", "2020-08-12");
    expect(delta).toMatchObject({ days: 2, narrows: false, label: "+2d" });
  });

  it("flags an end override that cuts off dated work", () => {
    const delta = projectDateDelta("end", "2020-08-12", "2020-08-10");
    expect(delta).toMatchObject({ days: -2, narrows: true, label: "-2d" });
    expect(delta?.description).toContain("outside the window");
  });

  it("flags a start override later than the earliest dated work", () => {
    expect(projectDateDelta("start", "2020-07-28", "2020-07-31")).toMatchObject(
      { days: 3, narrows: true, label: "+3d" },
    );
  });

  it("reads a start override earlier than the first dated work as slack", () => {
    expect(projectDateDelta("start", "2020-07-31", "2020-07-28")).toMatchObject(
      { days: -3, narrows: false, label: "-3d" },
    );
  });

  it("singularizes a one-day delta and counts across a month boundary", () => {
    expect(
      projectDateDelta("end", "2020-07-31", "2020-08-01")?.description,
    ).toBe("End is 1 day after the latest dated work");
    expect(projectDateDelta("end", "2020-07-01", "2020-08-31")?.days).toBe(61);
  });
});
