/**
 * Failures: a shipped, delivered or duplicate confirmation notice links a
 * Purchase that is not the one same-Vendor order its identifier names (two
 * matches, no match, another Vendor's order, an unknown sender); a refund,
 * cancellation or return reads as shipped or delivered; a confirmation links
 * a Purchase no import itemized; a match on another member's account or an
 * Email with retained attachment bytes skips the judgment `mail.resolve`
 * would ask a model for; an abstaining (`uncertain`), member-resolved or
 * member-selected Email is disposed of as unrelated.
 */
import { testEntityId, testShortcode } from "@cubby/schemas/testing";
import { describe, expect, it } from "vitest";

import {
  decideMailByRule,
  mailLifecycleEvent,
  orderIdentifiers,
  type MailRuleEvidence,
} from "./mail-import-rule";

const vendorId = testEntityId("vendor", "rule-shop");
const otherVendorId = testEntityId("vendor", "rule-other-shop");
const purchaseId = testShortcode("purchase", "rule-order");
const siblingId = testShortcode("purchase", "rule-sibling-order");

const candidate = {
  purchaseId,
  vendorId,
  ownAccount: true,
  importedSource: true,
};

const newsletter = {
  subject: "Synthetic garden newsletter",
  text: "Seasonal planting tips.",
  candidates: [],
} satisfies Partial<MailRuleEvidence>;

const evidence = (
  overrides: Partial<MailRuleEvidence> = {},
): MailRuleEvidence => ({
  subject: "Your order SYN-1001 has shipped",
  text: "Order #SYN-1001 is on its way. Track your package.",
  classification: "related",
  classificationStage: "decision",
  memberSelected: false,
  senderVendorId: vendorId,
  retainedAttachments: 0,
  candidates: [candidate],
  ...overrides,
});

describe("mail import rule", () => {
  it.each([
    ["Your order SYN-1001 has shipped", "shipped"],
    ["Shipped: synthetic kettle", "shipped"],
    ["Your package is out for delivery", "shipped"],
    ["Delivered: your Synthetic Shop order SYN-1001", "delivered"],
    ["Your package has been delivered", "delivered"],
    ["Order confirmation SYN-1001", "confirmation"],
    ["Thank you for your order!", "confirmation"],
  ] as const)("reads %j as %s", (subject, event) => {
    expect(mailLifecycleEvent(subject, "")).toBe(event);
  });

  it.each([
    "Your refund for order SYN-1001 has been processed",
    "Your return of SYN-1001 was delivered",
    "Order SYN-1001 cancelled",
    "Your order SYN-1001 was canceled",
    "Delivery attempt failed for SYN-1001",
    "Shipped and delivered: SYN-1001",
    "Your Synthetic Shop order SYN-1001",
    null,
  ])("never reads %j as a rule-settled lifecycle notice", (subject) => {
    expect(mailLifecycleEvent(subject, "")).toBeNull();
  });

  it("refuses a shipped subject whose body reports a reversal", () => {
    expect(
      mailLifecycleEvent(
        "Your order SYN-1001 has shipped",
        "One item in this order was cancelled and refunded.",
      ),
    ).toBeNull();
    expect(
      mailLifecycleEvent(
        "Your order SYN-1001 has shipped",
        "Returns are free within 30 days. Non-refundable items are marked.",
      ),
    ).toBe("shipped");
  });

  it("leaves an active-voice item cancellation to the coordinator", () => {
    expect(
      decideMailByRule(
        evidence({
          text: "Order #SYN-1001 shipped. We cancelled the unavailable item.",
        }),
      ).kind,
    ).toBe("coordinator");
  });

  it("finds printed order identifiers, not amounts or phrases", () => {
    expect(
      orderIdentifiers(
        "Your order #SYN-1001 has shipped",
        "Order number: 112-3344556-7788990. Order total $24.00.",
      ),
    ).toEqual(expect.arrayContaining(["SYN-1001", "112-3344556-7788990"]));
    expect(
      orderIdentifiers("Synthetic newsletter", "Save $24.00 today"),
    ).toEqual([]);
  });

  it("links the one same-Vendor Purchase its identifier names", () => {
    expect(decideMailByRule(evidence())).toEqual({
      kind: "linked",
      purchaseId,
      event: "shipped",
    });
    expect(
      decideMailByRule(
        evidence({
          subject: "Delivered: your order SYN-1001",
          candidates: [
            candidate,
            { ...candidate, purchaseId: siblingId, vendorId: otherVendorId },
          ],
        }),
      ),
    ).toEqual({ kind: "linked", purchaseId, event: "delivered" });
  });

  it.each<[string, Partial<MailRuleEvidence>]>([
    [
      "an unrelated Email with retained attachment bytes",
      {
        ...newsletter,
        classification: "unrelated",
        classificationStage: "decision",
        retainedAttachments: 1,
      },
    ],
    [
      "an unrelated cancellation with no recorded order",
      {
        ...newsletter,
        subject: "Your order was cancelled",
        classification: "unrelated",
        classificationStage: "decision",
      },
    ],
    [
      "an unrelated body reporting a refund",
      {
        ...newsletter,
        text: "We refunded the unavailable item.",
        classification: "unrelated",
        classificationStage: "decision",
      },
    ],
    [
      "two same-Vendor matches",
      { candidates: [candidate, { ...candidate, purchaseId: siblingId }] },
    ],
    ["no match", { candidates: [] }],
    [
      "only another Vendor's match",
      { candidates: [{ ...candidate, vendorId: otherVendorId }] },
    ],
    ["no sender-proof Vendor", { senderVendorId: null }],
    ["a refund", { subject: "Refund issued for order SYN-1001" }],
    ["a cancellation", { subject: "Your order SYN-1001 has been cancelled" }],
    ["a return", { subject: "Return received for order SYN-1001" }],
    [
      "a new order's confirmation",
      {
        subject: "Order confirmation SYN-1001",
        candidates: [{ ...candidate, importedSource: false }],
      },
    ],
    [
      "another member's account",
      { candidates: [{ ...candidate, ownAccount: false }] },
    ],
    ["retained attachment bytes", { retainedAttachments: 1 }],
    ["an unrecognized notice", { subject: "An update about SYN-1001" }],
  ])("hands the coordinator %s", (_case, overrides) => {
    expect(decideMailByRule(evidence(overrides)).kind).toBe("coordinator");
  });

  it("settles a duplicate confirmation of an imported order", () => {
    expect(
      decideMailByRule(evidence({ subject: "Order confirmation SYN-1001" })),
    ).toEqual({ kind: "linked", purchaseId, event: "confirmation" });
  });

  it.each(["rule", "decision", "model"] as const)(
    "resolves a confident %s unrelated classification unrelated",
    (stage) => {
      expect(
        decideMailByRule(
          evidence({
            ...newsletter,
            classification: "unrelated",
            classificationStage: stage,
          }),
        ),
      ).toMatchObject({ kind: "unrelated" });
    },
  );

  it.each<[string, Partial<MailRuleEvidence>]>([
    [
      "an abstaining classifier",
      {
        ...newsletter,
        classification: "uncertain",
        classificationStage: "model",
      },
    ],
    [
      "an unrelated classification of a matching lifecycle notice",
      { classification: "unrelated", classificationStage: "decision" },
    ],
    [
      "an earlier resolution",
      {
        ...newsletter,
        classification: "unrelated",
        classificationStage: "resolution",
      },
    ],
    [
      "a member's own selection",
      {
        ...newsletter,
        classification: "unrelated",
        classificationStage: "decision",
        memberSelected: true,
      },
    ],
  ])("hands the coordinator %s", (_case, overrides) => {
    expect(decideMailByRule(evidence(overrides)).kind).toBe("coordinator");
  });
});
