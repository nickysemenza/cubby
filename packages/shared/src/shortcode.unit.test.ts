import { z } from "zod";
import { describe, expect, expectTypeOf, it } from "vitest";

import {
  LEGACY_SHORTCODE_PREFIX,
  SHORTCODE_CHARS,
  SHORTCODE_PREFIX,
  type LocationShortcode,
  type ProductShortcode,
  type ShortcodeFor,
  type ShortcodeType,
  extractShortcodeFromScan,
  generateShortcode,
  parseShortcode,
  parseShortcodeFor,
  shortcodeSchema,
} from "./shortcode";

const ENTITIES = Object.keys(SHORTCODE_PREFIX).filter(
  (entity): entity is ShortcodeType => Object.hasOwn(SHORTCODE_PREFIX, entity),
);

describe("prefix registry", () => {
  it("uses a distinct prefix per entity", () => {
    const prefixes = Object.values(SHORTCODE_PREFIX);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it("keeps legacy prefixes disjoint from canonical ones", () => {
    const canonical = new Set<string>(Object.values(SHORTCODE_PREFIX));
    for (const legacy of Object.keys(LEGACY_SHORTCODE_PREFIX)) {
      expect(canonical.has(legacy)).toBe(false);
    }
  });

  it("keeps only the two prefixes that were actually minted", () => {
    expect(LEGACY_SHORTCODE_PREFIX).toEqual({
      "P-": "product",
      "L-": "location",
    });
  });

  it("has an alphabet free of scan-confusable characters", () => {
    // The comment on SHORTCODE_CHARS used to claim 32; it is 31, and the
    // namespace math (31^4) depends on that being right.
    expect(SHORTCODE_CHARS).toHaveLength(31);
    for (const confusable of ["0", "O", "1", "I", "L"]) {
      expect(SHORTCODE_CHARS).not.toContain(confusable);
    }
  });
});

describe("shortcodeSchema", () => {
  it.each(ENTITIES)("normalizes and brands a %s code", (entity) => {
    const schema = shortcodeSchema(entity);
    const canonical = `${SHORTCODE_PREFIX[entity]}4K7M`;
    expect(schema.parse(canonical)).toBe(canonical);
    expect(schema.parse(`  ${canonical.toLowerCase()}  `)).toBe(canonical);
  });

  it.each(ENTITIES)("rejects another entity's prefix for %s", (entity) => {
    const schema = shortcodeSchema(entity);
    for (const other of ENTITIES) {
      if (other === entity) continue;
      expect(schema.safeParse(`${SHORTCODE_PREFIX[other]}4K7M`).success).toBe(
        false,
      );
    }
  });

  it("rejects confusable characters and wrong lengths", () => {
    const schema = shortcodeSchema("product");
    for (const bad of [
      "PRD-0OIL",
      "PRD-4K7",
      "PRD-4K7MM",
      "PRD-",
      "4K7M",
      "",
    ]) {
      expect(schema.safeParse(bad).success).toBe(false);
    }
  });

  it("preserves the entity brand through generic schema lookup", () => {
    const parsed = shortcodeSchema("product").parse("PRD-4K7M");
    expectTypeOf(parsed).toEqualTypeOf<ProductShortcode>();
    expectTypeOf<ShortcodeFor<"product">>().toEqualTypeOf<ProductShortcode>();
    expectTypeOf(
      parseShortcodeFor("product", "prd-4k7m"),
    ).toEqualTypeOf<ProductShortcode>();
    expect(parseShortcodeFor("product", " prd-4k7m ")).toBe("PRD-4K7M");
  });

  /**
   * The regression this guards is invisible at runtime: a `transform().pipe()`
   * shape parses identically but becomes a ZodPipe, whose INPUT-side JSON Schema
   * is a bare {"type":"string"}. MCP advertises the input side to agents, so that
   * would silently strip the prefix hint from every tool that takes an id.
   */
  it.each(ENTITIES)(
    "publishes its pattern and description as JSON Schema for %s",
    (entity) => {
      const schema = shortcodeSchema(entity);
      for (const io of ["input", "output"] as const) {
        const json = z.toJSONSchema(z.object({ id: schema }), { io });
        // SAFETY: z.object({ id: schema }) always emits a properties.id schema
        // object; this assertion names only the optional fields under test.
        const id = json.properties?.id as
          | { pattern?: string; description?: string }
          | undefined;
        expect(id?.pattern).toContain(SHORTCODE_PREFIX[entity]);
        expect(id?.description).toContain(entity);
      }
    },
  );
});

describe("generateShortcode", () => {
  it("returns the entity's exact branded shortcode", () => {
    expectTypeOf(
      generateShortcode("product"),
    ).toEqualTypeOf<ProductShortcode>();
  });

  it.each(ENTITIES)(
    "produces codes its own schema accepts for %s",
    (entity) => {
      const schema = shortcodeSchema(entity);
      for (let i = 0; i < 50; i++) {
        expect(schema.safeParse(generateShortcode(entity)).success).toBe(true);
      }
    },
  );
});

describe("parseShortcode", () => {
  it("keeps the discriminator correlated with the shortcode brand", () => {
    const parsed = parseShortcode("PRD-4K7M");
    if (parsed?.type === "product") {
      expectTypeOf(parsed.shortcode).toEqualTypeOf<ProductShortcode>();
    }
  });

  /**
   * The schema and parser tables are built by `mapRecord` and cast to their
   * per-entity mapped types (see the SAFETY comments in shortcode.ts). These
   * assertions are what make that cast honest: every entity's brand is its
   * own, so a product code can never satisfy a location parameter, and the
   * parsed union narrows per entity rather than collapsing to one brand.
   */
  it("keeps every entity's brand distinct through the derived tables", () => {
    expectTypeOf<ShortcodeFor<"product">>().not.toEqualTypeOf<
      ShortcodeFor<"location">
    >();
    expectTypeOf<ProductShortcode>().not.toMatchTypeOf<LocationShortcode>();
    const parsed = parseShortcode("LOC-4K7M");
    if (parsed?.type === "location") {
      expectTypeOf(parsed.shortcode).toEqualTypeOf<LocationShortcode>();
      expectTypeOf(parsed.shortcode).not.toEqualTypeOf<ProductShortcode>();
    }
    for (const entity of ENTITIES) {
      expect(shortcodeSchema(entity).description).toContain(
        SHORTCODE_PREFIX[entity],
      );
    }
  });

  it.each(ENTITIES)("round-trips a canonical %s code", (entity) => {
    const code = generateShortcode(entity);
    expect(parseShortcode(code)).toEqual({
      type: entity,
      shortcode: code,
      legacy: false,
    });
  });

  it("canonicalizes legacy single-letter codes", () => {
    // The whole reason no alias table exists: the body survives the prefix swap,
    // so a QR label printed before the cutover still names the same row.
    expect(parseShortcode("P-4K7M")).toEqual({
      type: "product",
      shortcode: "PRD-4K7M",
      legacy: true,
    });
    expect(parseShortcode("  L-4K7M  ")).toMatchObject({
      type: "location",
      shortcode: "LOC-4K7M",
      legacy: true,
    });
    expect(parseShortcode("R-4K7M")).toBeNull();
  });

  it("rejects malformed input", () => {
    for (const bad of [
      "",
      "4K7M",
      "-4K7M",
      "ZZZ-4K7M",
      "PRD-0OIL",
      "PRD-4K7",
      "PRD_4K7M",
    ]) {
      expect(parseShortcode(bad)).toBeNull();
    }
  });
});

describe("extractShortcodeFromScan", () => {
  it("reads a code out of a label URL, canonical or legacy", () => {
    expect(
      extractShortcodeFromScan("https://cubby.example.com/PRD-4K7M"),
    ).toMatchObject({ type: "product", shortcode: "PRD-4K7M" });
    expect(
      extractShortcodeFromScan("https://cubby.example.com/L-4K7M"),
    ).toMatchObject({ type: "location", shortcode: "LOC-4K7M", legacy: true });
  });

  it("reads a bare code and rejects an unrelated URL", () => {
    expect(extractShortcodeFromScan(" prd-4k7m ")).toMatchObject({
      shortcode: "PRD-4K7M",
    });
    expect(
      extractShortcodeFromScan("https://example.com/some/page"),
    ).toBeNull();
  });
});
