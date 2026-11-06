import { EXTRACT_ORDER_TOOL } from "@cubby/schemas/import-run-agent";
import { describe, expect, it } from "vitest";

import { mailAttempts } from "./mail-attempts";

// A stale claim must never authorize ordinary extraction for the next source.
describe("Mail extraction attempts", () => {
  it("requires a current checksum-bound claim and clears it when no readable work remains", () => {
    const data = new Map<string, string>();
    const store = {
      read: (key: string) => data.get(key),
      write: (key: string, value: string) => {
        data.set(key, value);
      },
    };
    const budget = mailAttempts(store);

    budget.observeClaim({
      kind: "email",
      email: { mailboxId: "synthetic-mailbox", messageId: "synthetic-message" },
      read: { checksum: "c".repeat(64) },
    });

    budget.observeClaim({
      kind: "email",
      email: { mailboxId: "synthetic-mailbox", messageId: "synthetic-message" },
      read: {
        checksum: "c".repeat(64),
        boundToRun: true,
        attachments: [],
        content: {
          bodyText: "Synthetic retained original",
          truncated: false,
          nextOffset: null,
          bodyShortened: false,
          headersOmitted: false,
          linksOmitted: 0,
          imagesOmitted: 0,
          structuredDataOmitted: 0,
        },
      },
    });
    expect(budget.ordinaryEvidence()).toMatchObject({
      checksum: "c".repeat(64),
    });
    expect(budget.extractionBlock(EXTRACT_ORDER_TOOL)).toBeUndefined();
    budget.observeClaim({
      kind: "email",
      evidenceVersion: "synthetic-version",
      email: {
        mailboxId: "synthetic-mailbox",
        messageId: "synthetic-message",
        checksum: "c".repeat(64),
      },
      read: {
        checksum: "c".repeat(64),
        boundToRun: true,
        attachments: [],
        content: {
          bodyText: "Synthetic priced receipt with omitted decorative links",
          truncated: false,
          nextOffset: null,
          bodyShortened: false,
          headersOmitted: false,
          linksOmitted: 1,
          imagesOmitted: 0,
          structuredDataOmitted: 0,
        },
      },
    });
    expect(budget.source()?.evidenceVersion).toBe("synthetic-version");
    expect(budget.ordinaryEvidence()).toBeUndefined();
    expect(budget.extractionBlock(EXTRACT_ORDER_TOOL)).toContain(
      "consumes no extraction attempt",
    );
    expect(
      budget.extractionBlock("mcp__cubby__purchase_import"),
    ).toBeUndefined();
    budget.observeClaim({
      kind: "email",
      email: {
        mailboxId: "synthetic-mailbox",
        messageId: "synthetic-message",
        checksum: "c".repeat(64),
      },
      read: null,
    });
    expect(budget.ordinaryEvidence()).toBeUndefined();

    budget.observeClaim({ kind: "none" });
    expect(budget.source()).toBeUndefined();
  });
});
