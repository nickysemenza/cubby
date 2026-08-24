import { UNRESOLVABLE_ENTITY_FILTER } from "@cubby/shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  urlEnumListParam,
  urlShortcodeListParam,
  urlShortcodeParam,
  urlStringParam,
} from "./search-params";

/**
 * These assert against the values TanStack Router's `parseSearch` actually
 * hands a route — it JSON-parses each param, so the schema sees a number for
 * `?q=486242` and a boolean for `?future=true`, never the source text. A bare
 * `z.string()` sent both to `.catch(undefined)`, dropping the param with no
 * error and leaving an unfiltered view that reads as a real answer.
 */
describe("urlStringParam", () => {
  it("passes ordinary strings through untouched", () => {
    expect(urlStringParam.parse("Tool Nirvana")).toBe("Tool Nirvana");
    expect(urlStringParam.parse("111-1234567-1234567")).toBe(
      "111-1234567-1234567",
    );
  });

  it("recovers an all-digits value parsed as a number", () => {
    expect(urlStringParam.parse(11334)).toBe("11334");
    expect(urlStringParam.parse(486242)).toBe("486242");
  });

  it("drops a numeric value too long to have survived JSON.parse intact", () => {
    expect(urlStringParam.parse(300902141253424770)).toBeUndefined();
    expect(urlStringParam.parse(Number.MAX_SAFE_INTEGER)).toBe(
      String(Number.MAX_SAFE_INTEGER),
    );
  });

  it("recovers a true/false value parsed as a boolean", () => {
    expect(urlStringParam.parse(true)).toBe("true");
    expect(urlStringParam.parse(false)).toBe("false");
  });

  it("leaves an absent param absent rather than defaulting it", () => {
    expect(urlStringParam.parse(undefined)).toBeUndefined();
  });

  it("drops a value with no sensible string form instead of throwing", () => {
    // `.catch(undefined)` — a malformed param must not take down the route.
    // These have no meaningful filter reading, so absent is the right answer
    // (and notably NOT the string "null" / "[object Object]").
    expect(urlStringParam.parse(null)).toBeUndefined();
    expect(urlStringParam.parse({ a: 1 })).toBeUndefined();
    expect(urlStringParam.parse([1, 2])).toBeUndefined();
  });
});

describe("validated URL filter params", () => {
  it("drops malformed enum values after refinement", () => {
    const statusParam = urlEnumListParam(z.enum(["open", "done"]));

    expect(statusParam.parse("open,done")).toBe("open,done");
    expect(statusParam.parse("open,unknown")).toBeUndefined();
  });

  it("uses the canonical shortcode schema for validation and normalization", () => {
    const productsParam = urlShortcodeListParam("product");

    expect(productsParam.parse("prd-4k7m, PRD-2ABC ")).toBe(
      "PRD-4K7M,PRD-2ABC",
    );
    expect(productsParam.parse("LOC-4K7M")).toBe(UNRESOLVABLE_ENTITY_FILTER);
    expect(productsParam.parse("PRD-0OIL")).toBe(UNRESOLVABLE_ENTITY_FILTER);
    expect(productsParam.parse(486242)).toBe(UNRESOLVABLE_ENTITY_FILTER);
  });

  it("preserves invalid exact scopes as a match-nothing filter", () => {
    const productParam = urlShortcodeParam("product");

    expect(productParam.parse("PRD-4K7M")).toBe("PRD-4K7M");
    expect(productParam.parse("PRD-4K7M,PRD-2ABC")).toBe(
      UNRESOLVABLE_ENTITY_FILTER,
    );
    expect(productParam.parse(undefined)).toBeUndefined();
  });
});
