import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toFtsQuery } from "./fts-query";

// Runs the generated MATCH strings against a real FTS5 table built with the
// same tokenizer as the D1 edge index (scripts/build-edge-artifacts.ts), so a
// query that FTS5 rejects as a syntax error fails here instead of as a 500 in
// production.
describe("toFtsQuery against FTS5", () => {
  let db: Database.Database;
  let match: (query: string) => string[];

  beforeAll(() => {
    db = new Database(":memory:");
    db.exec(
      "CREATE VIRTUAL TABLE food_search USING fts5(" +
        "fdc_id UNINDEXED, data_type UNINDEXED, " +
        "description, short_description, brand_name, brand_owner, " +
        "tokenize='unicode61 remove_diacritics 1')",
    );
    const insert = db.prepare(
      "INSERT INTO food_search VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const [id, description] of [
      [1, "Wheat flour, white, all-purpose, enriched, bleached"],
      [2, "Wheat flour, whole-grain"],
      [3, "Macaroni & cheese dinner, prepared"],
      [4, "Chicken, broilers or fryers, breast, meat only, raw"],
    ] as const) {
      insert.run(id, "sr_legacy_food", description, "", "", "");
    }
    const stmt = db.prepare<[string], { description: string }>(
      "SELECT description FROM food_search WHERE food_search MATCH ? ORDER BY rank",
    );
    match = (query) => stmt.all(query).map((row) => row.description);
  });

  afterAll(() => {
    db.close();
  });

  it("hyphenated input matches the hyphenated description", () => {
    expect(match(toFtsQuery("all-purpose flour"))).toEqual([
      "Wheat flour, white, all-purpose, enriched, bleached",
    ]);
  });

  it("matches the same rows whether the user types the hyphen or a space", () => {
    expect(match(toFtsQuery("all-purpose flour"))).toEqual(
      match(toFtsQuery("all purpose flour")),
    );
  });

  it("keeps prefix matching on the trailing term", () => {
    expect(match(toFtsQuery("whole-gr"))).toEqual(["Wheat flour, whole-grain"]);
  });

  it.each([
    "Kraft Mac & Cheese",
    "flour (wheat)",
    "brand:flour",
    "chicken OR beef",
    "flour NOT wheat",
    "NEAR(flour wheat)",
    "flour -",
    'flour "',
  ])("does not throw for %j", (input) => {
    expect(() => match(toFtsQuery(input))).not.toThrow();
  });

  it("returns an empty query for punctuation-only input so callers skip MATCH", () => {
    // `MATCH ''` is itself a syntax error; the caller (data/edge.ts) treats an
    // empty result as "no name filter".
    expect(toFtsQuery("-")).toBe("");
    expect(() => match("")).toThrow(/syntax error/);
  });

  it("treats FTS5 operators as literal words", () => {
    // Unquoted, `chicken OR beef` would match the chicken row; quoted, the
    // literal token "OR" must also be present, so nothing matches.
    expect(match(toFtsQuery("chicken OR beef"))).toEqual([]);
    expect(match(toFtsQuery("macaroni & cheese"))).toEqual([
      "Macaroni & cheese dinner, prepared",
    ]);
  });
});
