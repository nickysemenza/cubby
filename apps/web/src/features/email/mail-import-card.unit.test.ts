import type { MailImportStatus } from "@cubby/schemas/mail-import-settings";
import { describe, expect, it } from "vitest";

import { mailImportRefetchInterval } from "./mail-import-card";

const status = (
  enabled: boolean,
  inProgress: MailImportStatus["mailboxes"][number]["searches"]["inProgress"],
  pending: MailImportStatus["mailboxes"][number]["searches"]["nextPending"] = [],
): MailImportStatus => ({
  mailboxes: [
    {
      mailboxId: "synthetic-mailbox",
      label: "Synthetic member · Gmail",
      enabled,
      searches: {
        vendors: { completed: 0, total: pending.length },
        charges: { completed: 0, total: 0 },
        senders: { completed: 0, total: 0 },
        inProgress,
        nextPending: pending,
      },
    },
  ],
});
const query = { key: "merchant:synthetic shop", query: '"synthetic shop"' };

// Failures: a card frozen at its first load while searches run; a card that
// keeps polling while searches wait for the next pass or with Mail import off.
describe("Mail import card refresh", () => {
  it("polls only while a switched-on mailbox is part-way through a search", () => {
    expect(mailImportRefetchInterval(status(true, query))).toBe(30_000);
    expect(mailImportRefetchInterval(status(true, null, [query]))).toBe(false);
    expect(mailImportRefetchInterval(status(true, null))).toBe(false);
    expect(mailImportRefetchInterval(status(false, query))).toBe(false);
    expect(mailImportRefetchInterval(undefined)).toBe(false);
  });
});
