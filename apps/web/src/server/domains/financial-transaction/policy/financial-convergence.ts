/** Reads: live account, dated resolved funding party, owner/member identities, primary-holder resolution, authorized-user periods and payment date window. Missing parties remain null. */
export function convergenceAccountAvailable(input: {
  funderId: string | null;
  funderKind: string | null;
  ownerId: string | null;
  ownerKind: string | null;
  memberId: string | null;
  memberCode: string | null;
  primaryHolderId: string | null;
  from: string | null;
  to: string | null;
  authorizedUsers: readonly {
    ledgerPartyId: string;
    validFrom: string | null;
    validTo: string | null;
  }[];
}) {
  const funded =
    input.funderKind === "household" ||
    (input.memberId !== null && input.funderId === input.memberId);
  const owns =
    input.ownerKind === "household" ||
    (input.memberId !== null &&
      (input.ownerId === input.memberId ||
        input.primaryHolderId === input.memberId));
  const authorized =
    input.memberCode !== null &&
    input.authorizedUsers.some(
      (period) =>
        period.ledgerPartyId === input.memberCode &&
        (period.validFrom === null ||
          (input.from !== null && period.validFrom <= input.from)) &&
        (period.validTo === null ||
          (input.to !== null && input.to <= period.validTo)),
    );
  return funded && (owns || authorized);
}

type Read =
  | {
      kind: "payment";
      transaction: {
        status: string;
        kind: string;
        amountMinor: bigint;
        ledgerTransferId: string | null;
      } | null;
    }
  | { kind: "authority"; authorized: boolean }
  | { kind: "source"; referenceCount: number }
  | {
      kind: "allocations";
      amountMinor: bigint;
      allocations: readonly { amountMinor: bigint }[];
    }
  | { kind: "identity"; purchaseId: string | null; vendorId: string | null }
  | {
      kind: "target";
      purchaseId: string | null;
      targetVendorId: string | null;
      verifiedVendorId: string | null;
      hasTarget: boolean;
      hasAcceptedVendor: boolean;
    }
  | { kind: "settlement"; conflicting: boolean }
  | {
      kind: "booking";
      hasTarget: boolean;
      allocationCount: number;
      storedDecision: string;
      currentDecision: string | null;
      storedLineage: string | null;
      currentLineage: string;
    };
/** Reads per stage: FinancialTransaction status/kind/amountMinor/ledgerTransferId; account authority above; source refs; complete live allocations; accepted Purchase/Vendor identity; settlement conflicts; exact retained decision/lineage fingerprints. Empty searches never imply acceptance. */
export function financialConvergenceRefusal(input: Read): string | null {
  switch (input.kind) {
    case "payment":
      return !input.transaction ||
        ["void", "expected"].includes(input.transaction.status) ||
        input.transaction.kind !== "purchase" ||
        input.transaction.amountMinor <= 0n ||
        input.transaction.ledgerTransferId
        ? "Automatic booking requires observed purchase payment evidence. Transfers, repayments, refunds, reimbursements and incoming payments retain their meaning."
        : null;
    case "authority":
      return input.authorized
        ? null
        : "The payment needs a dated funding account available to this member: the household or the member funds it on the charge date, and the member owns the account, is its primary cardholder, or is an authorized user then.";
    case "source":
      return input.referenceCount
        ? null
        : "The payment has no stable source identity.";
    case "allocations":
      return input.allocations.length > 1 ||
        (input.allocations[0] &&
          input.allocations[0].amountMinor !== input.amountMinor)
        ? "Split or incomplete accepted allocations require individual reconciliation."
        : null;
    case "identity":
      return input.purchaseId || input.vendorId
        ? null
        : "No accepted Purchase identity or verified genuine financial payment establishes a new order.";
    case "target":
      if (
        input.purchaseId &&
        (!input.hasTarget ||
          (input.verifiedVendorId &&
            input.targetVendorId !== input.verifiedVendorId))
      )
        return "The accepted Purchase is missing or conflicts with the verified Vendor.";
      return input.hasTarget && !input.hasAcceptedVendor
        ? "Resolve the accepted Purchase's live Vendor before automatic booking."
        : null;
    case "settlement":
      return input.conflicting
        ? "This payment's account conflicts with the Purchase (another member's account, or not an account its payment evidence names); settle it by review."
        : null;
    case "booking":
      return !input.hasTarget ||
        !input.allocationCount ||
        input.storedDecision !== `automatic:${input.currentDecision}` ||
        !input.storedLineage ||
        input.storedLineage !== input.currentLineage
        ? "Accepted booking facts changed; reconcile the existing Expenses before another automatic write."
        : null;
  }
}
