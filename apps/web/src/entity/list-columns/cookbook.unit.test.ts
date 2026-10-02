import { describe, expect, it } from "vitest";

import { subjectOptions, subjectsFilterFn } from "./cookbook";

const rowWith = (subjects: string[]) => ({ getValue: () => subjects });

describe("cookbook subjects facet", () => {
  // TanStack would otherwise pick a string filterFn for an array cell value
  // and match nothing against a picked set.
  it("matches a book carrying any picked subject, and everything when none is picked", () => {
    const book = rowWith(["Baking", "Bread"]);
    expect(subjectsFilterFn(book, "subjects", ["Bread", "Soup"])).toBe(true);
    expect(subjectsFilterFn(book, "subjects", ["Soup"])).toBe(false);
    expect(subjectsFilterFn(book, "subjects", [])).toBe(true);
    expect(subjectsFilterFn(book, "subjects", undefined)).toBe(true);
    expect(subjectsFilterFn(rowWith([]), "subjects", ["Bread"])).toBe(false);
  });

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
