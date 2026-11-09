/** Rule verdicts skip every model, so a false negative silently drops a
 * purchase: order outcomes and receipt senders must stay with the models. */
import { describe, expect, it } from "vitest";

import { mailRelevanceRule } from "./mail-relevance-rules";

const rule = (from: string, subject: string) =>
  mailRelevanceRule({ from, subject });

describe("mail relevance rules", () => {
  it.each([
    [
      "USPS <USPSInformeddelivery@email.informeddelivery.usps.com>",
      "Your Daily Digest",
    ],
    [
      "eBay - seller <seller_x@members.ebay.com>",
      "seller sent a message about Synthetic Drill #1",
    ],
    ["Venmo <venmo@venmo.com>", "Synthetic Friend paid you $25.00"],
    ["eBay <ebay@ebay.com>", "Your October statement summary is ready"],
    ["Marketplace <payments@market.example>", "Your payout is on its way"],
    ["Landscaper <info@landscape.example>", "SOD ESTIMATE #123"],
    ["Store Pro <pro@e.store.example>", "Your Quote Expires on 5/27"],
    [
      "Store <care@mg.store.example>",
      "We noticed you left an item in your cart",
    ],
    ["Office Depot <officedepot@em.officedepot.com>", "BOGO deals inside"],
  ])("settles %s / %s as unrelated", (from, subject) => {
    expect(rule(from, subject)).toEqual(expect.any(String));
  });

  it.each([
    ["CB2 <cb2@mail.cb2.com>", "Your receipt for order #1 from CB2."],
    [
      "Store <orders@store.example>",
      "Your quote has been converted to order #42",
    ],
    ["eBay <ebay@ebay.com>", "You won Synthetic Camera Strap"],
    ["eBay <ebay@ebay.com>", "Order confirmed: Synthetic Drill"],
    ["USPS <auto-reply@usps.com>", "USPS Expected Delivery on Monday"],
    ["Store <orders@store.example>", "Delivery estimate updated for order #7"],
  ])("leaves %s / %s to the models", (from, subject) => {
    expect(rule(from, subject)).toBeNull();
  });
});
