import { describe, expect, it } from "vitest";
import { urlStringParam } from "./search-params";

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
    // Real order ids (Tool Nirvana's are pure digits) and the SKUs people
    // search the ledger for.
    expect(urlStringParam.parse(11334)).toBe("11334");
    expect(urlStringParam.parse(486242)).toBe("486242");
  });

  it("drops a numeric value too long to have survived JSON.parse intact", () => {
    // Lowe's order ids run past 2^53, so `?order=300902141253424770` reaches
    // this schema already rounded to …800. Coercing that would filter on an id
    // nobody typed and return a confidently empty ledger; dropping it at least
    // shows up as a missing chip. `<Link search>` quotes the value, so app
    // links keep working — only the hand-typed bare form is affected.
    expect(urlStringParam.parse(300902141253424770)).toBeUndefined();
    expect(urlStringParam.parse(Number.MAX_SAFE_INTEGER)).toBe(
      String(Number.MAX_SAFE_INTEGER),
    );
  });

  it("recovers a true/false value parsed as a boolean", () => {
    // The `future` filter's own option values are the literal strings
    // "true"/"false", so its URL form is indistinguishable from a JSON boolean.
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
