import assert from "node:assert/strict";
import test from "node:test";

import { findLiveCodes } from "./check-outward-text.ts";

test("outward text rejects both accepted shortcode lengths", () => {
  assert.deepEqual(findLiveCodes("PUR-ZZZZ and PUR-ZZZZZ"), [
    "PUR-ZZZZ",
    "PUR-ZZZZZ",
  ]);
  assert.deepEqual(findLiveCodes("PRD-4K7M"), []);
  assert.deepEqual(findLiveCodes("PRD-4K7MN"), ["PRD-4K7MN"]);
});
