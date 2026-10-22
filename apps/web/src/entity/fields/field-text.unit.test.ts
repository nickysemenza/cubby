import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { describe, expect, it } from "vitest";

import { compactFieldText } from "./field-text";

const field = (
  entity: "project" | "financialAccount" | "wish" | "task",
  key: string,
) => {
  const found = entityFieldModels[entity].fields.find(
    (candidate) => candidate.key === key,
  );
  if (!found) throw new Error(`no ${entity}.${key}`);
  return found;
};

describe("compactFieldText", () => {
  it("keeps compound dates visible in picker metadata with open-bound semantics", () => {
    expect(
      compactFieldText(
        "task",
        { due: { start: "2026-10-22", end: "2026-10-24" } },
        field("task", "due"),
      ),
    ).toBe("Oct 22 – 24, 2026");
    expect(
      compactFieldText(
        "project",
        { dates: { start: "2026-10-22", end: null } },
        field("project", "dates"),
      ),
    ).toBe("From Oct 22, 2026");
    expect(
      compactFieldText(
        "task",
        { due: { start: null, end: "2026-10-24" } },
        field("task", "due"),
      ),
    ).toBe("Through Oct 24, 2026");
    expect(
      compactFieldText("task", { due: null }, field("task", "due")),
    ).toBeNull();
  });
  // Regression: a money-control number (no currency display format) read as
  // an unexplained count in picker chips and their accessible names.
  it("formats a money-control number as currency", () => {
    expect(
      compactFieldText(
        "project",
        { id: "PRJ-4K7M", costEstimate: 1250 },
        field("project", "costEstimate"),
      ),
    ).toMatch(/^\$1,250/);
  });

  it("reads an enum as its label, never the stored key", () => {
    const text = compactFieldText(
      "project",
      { id: "PRJ-4K7M", status: "in_progress" },
      field("project", "status"),
    );
    expect(text).not.toBe("in_progress");
    expect(text).toBeTruthy();
  });

  it("reads a declared value-option path as its label", () => {
    expect(
      compactFieldText(
        "financialAccount",
        { id: "FAC-4K7M", identity: { kind: "stored_value" } },
        field("financialAccount", "identity"),
      ),
    ).toBe("Gift card or store credit");
  });

  it("reads a timestamp as a date even when it declares value options", () => {
    const at = "2026-03-14T12:00:00.000Z";
    expect(
      compactFieldText(
        "wish",
        { id: "WSH-4K7M", acquiredAt: at },
        field("wish", "acquiredAt"),
      ),
    ).toBe(new Date(at).toLocaleDateString());
  });
});
