import { expect, it } from "vitest";

import { pendingPostedMatch } from "./statement-suggestions";

it("bounds the pending-to-posted tolerance", () => {
  const hold = { amount: 40, date: "2026-05-01" };
  expect(pendingPostedMatch(hold, { amount: 60, date: "2026-05-03" })).toBe(
    true,
  );
  expect(pendingPostedMatch(hold, { amount: 60.01, date: "2026-05-03" })).toBe(
    false,
  );
  expect(pendingPostedMatch(hold, { amount: 39.99, date: "2026-05-03" })).toBe(
    false,
  );
  expect(pendingPostedMatch(hold, { amount: 40, date: "2026-05-09" })).toBe(
    false,
  );
});
