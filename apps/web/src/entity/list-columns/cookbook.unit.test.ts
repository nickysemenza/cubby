import { describe, expect, it } from "vitest";

import { subjectOptions } from "./cookbook";

describe("cookbook subjects facet", () => {
  it("lists each subject once per book, most-used first", () => {
    expect(
      subjectOptions([
        { subjects: ["Baking", "Baking", "Bread"] },
        { subjects: ["Bread"] },
        { subjects: ["Soup"] },
      ]),
    ).toEqual([
      { value: "Bread", label: "Bread", hint: "2" },
      { value: "Baking", label: "Baking", hint: "1" },
      { value: "Soup", label: "Soup", hint: "1" },
    ]);
  });
});
