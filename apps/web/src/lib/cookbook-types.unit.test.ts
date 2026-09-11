/**
 * Drift guard between the wasm boundary and the stored schemas.
 *
 * `packages/schemas/src/cookbook.ts` describes the shapes the server accepts
 * and stores; `@cubby/recipebridge` generates the shapes the `cookbook` crate
 * actually emits. Nothing at runtime re-derives one from the other, so the only
 * thing keeping them in agreement is the assignment inside `asStoredCookbook` /
 * `asStoredRunReport`: if the crate renames a field, drops one the schema
 * requires, or narrows a type, those stop compiling and `pnpm typecheck` fails
 * before a user's first extraction does.
 *
 * Direction matters. Crate → schema is the direction data flows (extract in the
 * browser, POST to `upsertCookbook`), so that is what is asserted. The schemas
 * stay deliberately looser — passthrough objects, extra optional fields — and a
 * loosening on the schema side is allowed by design.
 *
 * This file is where that failure is explained. The check itself is `tsc`'s.
 */

import type * as RecipeBridge from "@cubby/recipebridge";
import { describe, expect, it } from "vitest";

import { asStoredCookbook, asStoredRunReport } from "./cookbook-types";

describe("cookbook wasm types", () => {
  it("keeps the stored schemas assignable from the crate's book tree", () => {
    // SAFETY: `asStoredCookbook` is identity at runtime — it returns its
    // argument unchanged — so no field of this stand-in is ever read. Its only
    // job is to make the call site exist, which is what forces `tsc` to check
    // the assignment inside the conversion.
    const cookbook = { contract: "cookbook/1" } as RecipeBridge.Cookbook;
    // SAFETY: same for `asStoredRunReport` — identity at runtime, so this
    // stand-in is never read either.
    const report = { run_id: "run-1" } as RecipeBridge.RunReport;

    expect(asStoredCookbook(cookbook)).toBe(cookbook);
    expect(asStoredRunReport(report)).toBe(report);
  });
});
