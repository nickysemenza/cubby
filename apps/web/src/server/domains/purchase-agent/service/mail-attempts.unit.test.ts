import { describe, expect, it } from "vitest";

import { mailAttempts } from "./mail-attempts";

// Replays, coordinator reconstruction, new claim ids and model switches must
// not reset the semantic budget. Different source evidence gets a fresh budget.
describe("Mail extraction attempts", () => {
  it("keeps primary repair and escalation limits across recovery and repeated claims", () => {
    const data = new Map<string, string>();
    const store = {
      read: (key: string) => data.get(key),
      write: (key: string, value: string) => {
        data.set(key, value);
      },
    };
    const claimed = {
      kind: "email",
      email: { mailboxId: "synthetic-mailbox", messageId: "synthetic-message" },
      read: { checksum: "a".repeat(64) },
    };
    const original = mailAttempts(store);
    original.observeClaim(claimed);
    expect(original.admit("extract", "primary").kind).toBe("admitted");
    expect(original.admit("extract", "escalation").kind).toBe("admitted");
    const recovered = mailAttempts(store);
    recovered.observeClaim(claimed);
    expect(recovered.admit("repair", "primary").kind).toBe("admitted");
    expect(recovered.admit("another-prepare", "primary").kind).toBe(
      "exhausted",
    );
    expect(recovered.admit("stronger", "escalation").kind).toBe("admitted");
    expect(recovered.admit("another-stronger", "escalation").kind).toBe(
      "exhausted",
    );
    recovered.observeClaim({ ...claimed, read: { checksum: "b".repeat(64) } });
    expect(recovered.admit("revised-evidence", "primary").kind).toBe(
      "admitted",
    );
    recovered.observeClaim(claimed);
    expect(recovered.admit("old-evidence", "primary").kind).toBe("exhausted");
  });

  it("requires a current checksum-bound claim and clears it when no readable work remains", () => {
    const data = new Map<string, string>();
    const store = {
      read: (key: string) => data.get(key),
      write: (key: string, value: string) => {
        data.set(key, value);
      },
    };
    const budget = mailAttempts(store);
    expect(budget.admit("before-claim", "primary").kind).toBe("no_evidence");
    budget.observeClaim({
      kind: "email",
      email: { mailboxId: "synthetic-mailbox", messageId: "synthetic-message" },
      read: { checksum: "c".repeat(64) },
    });
    expect(budget.admit("extract", "primary").kind).toBe("admitted");
    budget.observeClaim({
      kind: "email",
      email: { mailboxId: "synthetic-mailbox", messageId: "synthetic-message" },
      read: {
        checksum: "c".repeat(64),
        boundToRun: true,
        attachments: [],
        content: {
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
    expect(budget.admit("read-error-repair", "primary").kind).toBe("admitted");
    expect(budget.admit("read-error-extra", "primary").kind).toBe("exhausted");
    budget.observeClaim({ kind: "none" });
    expect(budget.admit("stale-source", "primary").kind).toBe("no_evidence");
  });
});
