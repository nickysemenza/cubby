import { describe, expect, it } from "vitest";

import { statementEffectiveMovement } from "~/server/domains/transaction-import/repo/statement-policy-wire";

describe("statement effective movement", () => {
  it("projects loan classes independently of provider sign", () => {
    const loan = {
      providerVendorNames: ["Example Lender", "Example Alias"],
      proven: true,
    };
    const cases = [
      [" INTEREST ON ESC ", -12, "escrow_interest", -12],
      ["Escrow interest", 12, "escrow_interest", -12],
      ["Escrow refund", -12, "escrow_refund", -12],
      ["Automatic payment", 12, "loan_payment", -12],
      ["Example Alias", -12, "loan_payment", -12],
      ["County tax", -12, "escrow_disbursement", 12],
      ["Homeowners insurance disbursement", 12, "escrow_disbursement", 12],
      ["payment county tax", -12, "loan_unknown", 12],
      ["generic refund", -12, "loan_unknown", 12],
      ["payment", 0, "loan_unknown", -0],
      ["Example Lender loan servicing", -12, "loan_unknown", 12],
    ] as const;
    expect(
      cases.map(([description, providerAmount]) => {
        const result = statementEffectiveMovement({
          providerAmount,
          description,
          merchant: null,
          sourceCategory: null,
          loan,
        });
        return [
          result.movementClass,
          result.effectiveAmount,
          Boolean(result.reviewReason),
        ];
      }),
    ).toEqual(
      cases.map(([, , movementClass, amount]) => [
        movementClass,
        amount,
        movementClass === "loan_unknown",
      ]),
    );
    expect(
      statementEffectiveMovement({
        providerAmount: -12,
        description: "payment",
        merchant: null,
        sourceCategory: null,
        loan: null,
      }).effectiveAmount,
    ).toBe(12);
    expect(
      statementEffectiveMovement({
        providerAmount: 100,
        description: "Example deposit",
        merchant: null,
        sourceCategory: "Other Income",
        loan: { providerVendorNames: [], proven: false },
      }),
    ).toMatchObject({ movementClass: "loan_unknown", effectiveAmount: -100 });
  });
});
