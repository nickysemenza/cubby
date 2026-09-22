import { importRunId } from "@cubby/schemas/identifiers";
import { testEntityId } from "@cubby/schemas/testing";
import { describe, expect, it } from "vitest";

import { Database } from "~/server/db";

import {
  buildMergeShortlist,
  ingredientMergeSpec,
  type MergeShortlistEntry,
  type MergeShortlistPort,
} from "./merge-shortlist";

const db = new Database(() => {
  throw new Error(
    "Merge-shortlist unit ports do not resolve a database runtime",
  );
});

const runId = importRunId.parse("00000000-0000-4000-8000-000000000009");
const sourceId = testEntityId("ingredient", "source");
const source = { id: sourceId, name: "scallion" };

const entry = (
  id: string,
  name: string,
  productCount = 0,
): MergeShortlistEntry => ({
  id: testEntityId("ingredient", id),
  shortcode: `ING-${id}`,
  name,
  productCount,
});

const portOf = (
  lexical: MergeShortlistEntry[],
  semantic: MergeShortlistEntry[],
): MergeShortlistPort => ({
  lexical: async () => lexical,
  semantic: async () => semantic,
});

describe("buildMergeShortlist", () => {
  it("merges lexical hits before semantic hits", async () => {
    const green = entry("green-onion", "green onion");
    const scallionAlt = entry("scallion-alt", "scallion (bunched)");

    const shortlist = await buildMergeShortlist(
      db,
      source,
      runId,
      20,
      portOf([green], [scallionAlt]),
    );

    expect(shortlist.map((e) => e.name)).toEqual([
      "green onion",
      "scallion (bunched)",
    ]);
  });

  it("dedupes an id present in both legs, keeping the lexical entry", async () => {
    const shared = entry("shared", "shared candidate", 1);
    const sharedFromSemantic = { ...shared, productCount: 99 };

    const shortlist = await buildMergeShortlist(
      db,
      source,
      runId,
      20,
      portOf([shared], [sharedFromSemantic]),
    );

    expect(shortlist).toHaveLength(1);
    expect(shortlist[0]?.productCount).toBe(1);
  });

  it("drops the source ingredient itself even if a leg returns it", async () => {
    const self: MergeShortlistEntry = {
      id: sourceId,
      shortcode: "ING-SELF",
      name: "scallion",
      productCount: 0,
    };
    const other = entry("other", "green onion");

    const shortlist = await buildMergeShortlist(
      db,
      source,
      runId,
      20,
      portOf([self, other], []),
    );

    expect(shortlist.map((e) => e.id)).toEqual([other.id]);
  });

  it("caps the merged shortlist at the limit", async () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      entry(`c${i}`, `candidate ${i}`),
    );

    const shortlist = await buildMergeShortlist(
      db,
      source,
      runId,
      20,
      portOf(many, []),
    );

    expect(shortlist).toHaveLength(20);
  });

  it("degrades to the lexical leg alone when the semantic port returns nothing", async () => {
    const green = entry("green-onion", "green onion");

    const shortlist = await buildMergeShortlist(
      db,
      source,
      runId,
      20,
      portOf([green], []),
    );

    expect(shortlist).toEqual([green]);
  });
});

describe("ingredientMergeSpec", () => {
  it('renders a candidate as "id [N products]: name" and uses the id as the selection id', () => {
    const candidate = entry("green-onion", "green onion", 3);

    expect(ingredientMergeSpec.idOf(candidate)).toBe(candidate.id);
    expect(ingredientMergeSpec.renderLine(candidate)).toBe(
      `${candidate.id} [3 products]: green onion`,
    );
  });
});
