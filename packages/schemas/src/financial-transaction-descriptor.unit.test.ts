import { expect, it } from "vitest";

import { parseBankDescriptor } from "./financial-transaction-fields";

// Charges without a provider merchant search Gmail by their cleaned
// descriptor; the processor stays derivable for history review.
it.each([
  ["SQ *BLUE BOTTLE COFFEE SEATTLE WA", "square", "blue bottle coffee"],
  ["TST* JOES PIZZA #1234 PORTLAND OR", "toast", "joes pizza"],
  ["PAYPAL *SYNTHETICSHOP 4029357733", "paypal", "syntheticshop"],
  ["SP SYNTHETIC GOODS", "shopify", "synthetic goods"],
  ["SYNTHETIC HARDWARE 00123 SPRINGFIELD IL", null, "synthetic hardware"],
  ["TARGET WA", null, "target wa"],
  ["SQ *12345", "square", null],
  ["SQ  *SYNTHETIC MARKET", "square", "synthetic market"],
  ["  TST*\tSYNTHETIC CAFE", "toast", "synthetic cafe"],
  ["TST* SYNTHETIC DINER SAN FRANCISCO CA", "toast", "synthetic diner"],
  ["SYNTHETIC GRILL SALT LAKE CITY UT", null, "synthetic grill"],
  ["SYNTHETIC BAKERY       PORTLAND     OR", null, "synthetic bakery"],
  [null, null, null],
] as const)("parses %s", (raw, processor, merchant) => {
  expect(parseBankDescriptor(raw)).toEqual({ processor, merchant });
});
