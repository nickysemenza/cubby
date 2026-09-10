import { describe, expect, it } from "vitest";

import { inspectWorkflow } from "~/server/workflow-runtime/definition";

import {
  getCalendarRangeWorkflow,
  clearCalendarUncertainWriteWorkflow,
  rotateCalendarFeedWorkflow,
  rotateCalendarCredentialWorkflow,
  revokeCalendarCredentialWorkflow,
  getCalendarFeedWorkflow,
  getCalendarCredentialWorkflow,
  inspectCalendarFeedWorkflow,
} from "./calendar.server";

describe("calendar workflow graphs", () => {
  it("registers calendar operations", () => {
    expect(inspectWorkflow(getCalendarRangeWorkflow.definition).name).toBe(
      "calendar.range",
    );
    expect(
      inspectWorkflow(clearCalendarUncertainWriteWorkflow.definition).name,
    ).toBe("calendar.uncertainWrite.clear");
  });
  it("resolves clients before reads and marks completed remote writes", () => {
    for (const descriptor of [
      inspectWorkflow(getCalendarFeedWorkflow.definition),
      inspectWorkflow(getCalendarCredentialWorkflow.definition),
      inspectWorkflow(inspectCalendarFeedWorkflow.definition),
    ]) {
      expect(descriptor.steps.map((step) => step.type)).toEqual([
        "call",
        "call",
      ]);
    }
    for (const descriptor of [
      inspectWorkflow(rotateCalendarFeedWorkflow.definition),
      inspectWorkflow(rotateCalendarCredentialWorkflow.definition),
      inspectWorkflow(revokeCalendarCredentialWorkflow.definition),
      inspectWorkflow(clearCalendarUncertainWriteWorkflow.definition),
    ]) {
      expect(descriptor.steps.map((step) => step.type)).toEqual([
        "call",
        "committedCall",
      ]);
    }
  });
});
