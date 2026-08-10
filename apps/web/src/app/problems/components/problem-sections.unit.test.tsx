import {
  type AllProblems,
  PROBLEM_CLASS,
  type ProblemKey,
} from "@cubby/schemas/problems";
import { describe, expect, it } from "vitest";
import { PROBLEM_SECTIONS } from "./problem-sections";

type Section = (typeof PROBLEM_SECTIONS)[number];

const ALL_PROBLEM_KEYS = Object.keys(PROBLEM_CLASS) as ProblemKey[];

/**
 * The detector keys a section actually renders, taken from the section itself
 * rather than from a second hand-written list: `count` runs the section's own
 * `select` over a probe that records every key it touches. That is what makes
 * this file a check on `coverage.keys` and not just a restatement of it — a
 * section whose declared keys drift from its `select` fails here.
 */
function keysReadBy(section: Section): ProblemKey[] {
  const read = new Set<string>();
  const probe = new Proxy({} as AllProblems, {
    get: (_target, property) => {
      if (typeof property === "string") read.add(property);
      return [];
    },
  });
  section.count(probe);
  return [...read] as ProblemKey[];
}

const sorted = (keys: readonly string[]) => [...keys].sort();

describe("PROBLEM_SECTIONS", () => {
  it.each(PROBLEM_SECTIONS.map((s) => [s.id, s] as const))(
    "%s reads only known detector keys",
    (_id, section) => {
      const keys = keysReadBy(section);
      expect(keys.length).toBeGreaterThan(0);
      expect(keys.filter((key) => !ALL_PROBLEM_KEYS.includes(key))).toEqual([]);
    },
  );

  // A section renders one group's worth of rows in one style; merging a defect
  // key into a coverage section (or the reverse) would put rows in a group that
  // contradicts how they are counted.
  it.each(PROBLEM_SECTIONS.map((s) => [s.id, s] as const))(
    "%s renders keys of a single class",
    (_id, section) => {
      const classes = new Set(
        keysReadBy(section).map((key) => PROBLEM_CLASS[key]),
      );
      expect([...classes]).toHaveLength(1);
    },
  );

  // The weld: the schema's class and the page's coverage marker are two
  // declarations of one membership, and nothing but this tied them together.
  it.each(PROBLEM_SECTIONS.map((s) => [s.id, s] as const))(
    "%s declares coverage exactly when its keys are classed coverage",
    (_id, section) => {
      const keys = keysReadBy(section);
      const isCoverageClassed = keys.every(
        (key) => PROBLEM_CLASS[key] === "coverage",
      );
      expect(section.coverage != null).toBe(isCoverageClassed);
      if (section.coverage) {
        expect(sorted(section.coverage.keys)).toEqual(sorted(keys));
      }
    },
  );

  it("renders every detector key in exactly one section", () => {
    const rendered = PROBLEM_SECTIONS.flatMap(keysReadBy);
    expect(sorted(rendered)).toEqual(sorted(ALL_PROBLEM_KEYS));
  });
});
