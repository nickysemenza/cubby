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
