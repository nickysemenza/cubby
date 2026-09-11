import { describe, expect, it } from "vitest";
import { toFtsQuery } from "./fts-query";

describe("toFtsQuery", () => {
  const CASES: { name: string; input: string; expected: string }[] = [
    { name: "empty input", input: "", expected: "" },
    { name: "whitespace-only input", input: "   ", expected: "" },
    { name: "tabs and newlines only", input: "\t\n", expected: "" },
    { name: "punctuation-only input", input: "- & ()", expected: "" },
    {
      name: "single term is quoted and gets a prefix wildcard",
      input: "apple",
      expected: '"apple"*',
    },
    {
      name: "multiple terms, wildcard on the last",
      input: "apple juice",
      expected: '"apple" "juice"*',
    },
    {
      name: "three terms, wildcard on the last",
      input: "red apple juice",
      expected: '"red" "apple" "juice"*',
    },
    {
      name: "collapses runs of spaces",
      input: "  apple   juice  ",
      expected: '"apple" "juice"*',
    },
    {
      name: "normalizes tabs/newlines to single spaces",
      input: "apple\tjuice\n",
      expected: '"apple" "juice"*',
    },
    {
      name: "strips double quotes",
      input: 'apple "juice"',
      expected: '"apple" "juice"*',
    },
    {
      name: "strips single quotes",
      input: "apple 'juice'",
      expected: '"apple" "juice"*',
    },
    {
      name: "strips quotes around a phrase",
      input: '"brand name"',
      expected: '"brand" "name"*',
    },
    {
      name: "mixed quotes and spaces",
      input: "  \"apple\"  'juice'  ",
      expected: '"apple" "juice"*',
    },
    {
      name: "real-world: Coca Cola Original",
      input: "Coca Cola Original",
      expected: '"Coca" "Cola" "Original"*',
    },
    // Regression: `-` is an FTS5 syntax token; the raw hyphen produced
    // `all - purpose` and a 500 from the deployed worker (2026-09-11).
    {
      name: "real-world: hyphen is a word break",
      input: "all-purpose flour",
      expected: '"all" "purpose" "flour"*',
    },
    {
      name: "real-world: trailing hyphenated term",
      input: "flour all-purpose",
      expected: '"flour" "all" "purpose"*',
    },
    {
      name: "real-world: ampersand is a word break",
      input: "Kraft Mac & Cheese",
      expected: '"Kraft" "Mac" "Cheese"*',
    },
    {
      name: "real-world: apostrophe is a word break",
      input: "Uncle Ben's Rice",
      expected: '"Uncle" "Ben" "s" "Rice"*',
    },
    {
      name: "parentheses are word breaks",
      input: "flour (wheat)",
      expected: '"flour" "wheat"*',
    },
    {
      name: "a column filter stays a literal term",
      input: "brand:flour",
      expected: '"brand" "flour"*',
    },
    {
      name: "FTS5 keywords are quoted, not interpreted",
      input: "fish OR chicken NOT beef",
      expected: '"fish" "OR" "chicken" "NOT" "beef"*',
    },
    {
      name: "keeps letters with diacritics and non-Latin scripts",
      input: "crème fraîche 味噌",
      expected: '"crème" "fraîche" "味噌"*',
    },
  ];

  it.each(CASES)("$name", ({ input, expected }) => {
    expect(toFtsQuery(input)).toBe(expected);
  });
});
