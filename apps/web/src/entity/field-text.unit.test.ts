import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { describe, expect, it } from "vitest";

import { compactFieldText } from "./field-text";

const field = (entity: "project", key: string) => {
  const found = entityFieldModels[entity].fields.find(
    (candidate) => candidate.key === key,
  );
  if (!found) throw new Error(`no ${entity}.${key}`);
  return found;
};

describe("compactFieldText", () => {
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
});
