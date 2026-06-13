import { describe, expect, it } from "vitest";
import { toFtsQuery } from "./fts-query";

describe("toFtsQuery", () => {
  const CASES: { name: string; input: string; expected: string }[] = [
    { name: "empty input", input: "", expected: "" },
    { name: "whitespace-only input", input: "   ", expected: "" },
    { name: "tabs and newlines only", input: "\t\n", expected: "" },
    {
      name: "single term gets a prefix wildcard",
      input: "apple",
      expected: "apple*",
    },
    {
      name: "multiple terms, wildcard on the last",
      input: "apple juice",
      expected: "apple juice*",
    },
    {
      name: "three terms, wildcard on the last",
      input: "red apple juice",
      expected: "red apple juice*",
    },
    {
      name: "collapses runs of spaces",
      input: "  apple   juice  ",
      expected: "apple juice*",
    },
    {
      name: "normalizes tabs/newlines to single spaces",
      input: "apple\tjuice\n",
      expected: "apple juice*",
    },
    {
      name: "strips double quotes",
      input: 'apple "juice"',
      expected: "apple juice*",
    },
    {
      name: "strips single quotes",
      input: "apple 'juice'",
      expected: "apple juice*",
    },
    {
      name: "strips quotes around a phrase",
      input: '"brand name"',
      expected: "brand name*",
    },
    {
      name: "mixed quotes and spaces",
      input: "  \"apple\"  'juice'  ",
      expected: "apple juice*",
    },
    {
      name: "prefix wildcard only on the last term (two)",
      input: "organic apple",
      expected: "organic apple*",
    },
    {
      name: "prefix wildcard only on the last term (three)",
      input: "red organic apple",
      expected: "red organic apple*",
    },
    {
      name: "real-world: Coca Cola Original",
      input: "Coca Cola Original",
      expected: "Coca Cola Original*",
    },
    {
      name: "real-world: keeps an ampersand",
      input: "Kraft Mac & Cheese",
      expected: "Kraft Mac & Cheese*",
    },
    {
      name: "real-world: apostrophe becomes a word break",
      input: "Uncle Ben's Rice",
      expected: "Uncle Ben s Rice*",
    },
  ];

  it.each(CASES)("$name", ({ input, expected }) => {
    expect(toFtsQuery(input)).toBe(expected);
  });
});
