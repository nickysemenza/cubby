import {
  mailboxCoverage,
  summarizeMailSearchProgress,
  type MailboxCoverage,
  type MailboxScopedPosition,
} from "@cubby/schemas/mailbox-research";
import { describe, expect, it } from "vitest";

import { creditScopedPage } from "./sync";

const coverage = (scoped: MailboxScopedPosition[]): MailboxCoverage =>
  mailboxCoverage.parse({
    version: 1,
    baselineHistoryId: "100",
    broad: { pageToken: null, completed: false },
    scoped,
    history: { historyId: "100", pageToken: null, targetHistoryId: null },
    nextLane: "scan",
  });
const vendorA = {
  key: "vendor:a:from:orders@a.example.test",
  query: "from:orders@a.example.test",
};
const vendorB = {
  key: "vendor:b:domain:b.example.test",
  query: '"b.example.test"',
};
const merchant = { key: "merchant:synthetic cafe", query: '"synthetic cafe"' };
const descriptor = {
  key: "descriptor:SYNTHETIC GRILL",
  query: '"SYNTHETIC GRILL"',
};

// Failures: stale completed entries inflating totals; a changed query text
// keeping its old completion; the in-progress search repeated as pending;
// unmerged targets missing from the queue; a replayed page double-counting.
describe("Mail search progress", () => {
  it("counts only current targets, split by Vendor and charge searches", () => {
    const stored = coverage([
      { ...vendorA, pageToken: null, completed: true },
      { ...merchant, pageToken: "page-2", completed: false },
      // Completed but no longer a target.
      {
        key: "merchant:gone",
        query: '"gone"',
        pageToken: null,
        completed: true,
      },
      // The target's query text changed, so this completion is not it.
      {
        ...vendorB,
        query: '"old.example.test"',
        pageToken: null,
        completed: true,
      },
    ]);
    expect(
      summarizeMailSearchProgress(stored, [
        vendorA,
        vendorB,
        merchant,
        descriptor,
      ]),
    ).toEqual({
      vendors: { completed: 1, total: 2 },
      charges: { completed: 0, total: 2 },
      inProgress: merchant,
      nextPending: [vendorB, descriptor],
    });
  });

  it("queues every target before the first pass and caps the sample", () => {
    const targets = Array.from({ length: 7 }, (_, index) => ({
      key: `merchant:shop ${index}`,
      query: `"shop ${index}"`,
    }));
    const progress = summarizeMailSearchProgress(null, targets);
    expect(progress.charges).toEqual({ completed: 0, total: 7 });
    expect(progress.inProgress).toBeNull();
    expect(progress.nextPending).toEqual(targets.slice(0, 5));
  });

  it("adds a targeted page's retained Emails and stamps its finish", () => {
    const now = new Date("2026-10-01T12:30:00.000Z");
    const middle = creditScopedPage(
      {
        scopedKey: merchant.key,
        nextCoverage: coverage([
          { ...merchant, pageToken: "page-2", completed: false },
        ]),
      },
      3,
      now,
    );
    expect(middle.scoped[0]).toEqual({
      ...merchant,
      pageToken: "page-2",
      completed: false,
      emailCount: 3,
    });
    const last = creditScopedPage(
      {
        scopedKey: merchant.key,
        nextCoverage: coverage([
          { ...middle.scoped[0]!, pageToken: null, completed: true },
        ]),
      },
      2,
      now,
    );
    expect(last.scoped[0]).toMatchObject({
      completed: true,
      emailCount: 5,
      completedAt: now.toISOString(),
    });
    // A new-mail page names no search and leaves coverage as listed.
    expect(creditScopedPage({ nextCoverage: last }, 9, now)).toEqual(last);
  });
});
