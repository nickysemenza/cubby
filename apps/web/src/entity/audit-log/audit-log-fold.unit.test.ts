import { runShortcode } from "@cubby/schemas/identifiers";
import { describe, expect, it } from "vitest";

import { type FoldableAuditEntry, foldAuditEntries } from "./audit-log-fold";

const entry = (
  key: string,
  minute: number,
  patch: Partial<FoldableAuditEntry> = {},
): FoldableAuditEntry => ({
  entryKey: key,
  entityKind: "product",
  entityId: "PRD-4K7M",
  action: "update",
  userId: "user-a",
  channel: "web",
  oauthClient: null,
  device: null,
  runId: null,
  createdAt: new Date(Date.UTC(2026, 9, 11, 12, 0) - minute * 60_000),
  changes: { name: { from: "a", to: "b" } },
  ...patch,
});

const keys = (groups: ReturnType<typeof foldAuditEntries>) =>
  groups.map((group) => group.map((item) => item.entryKey));

describe("foldAuditEntries", () => {
  it("folds consecutive edits by one actor to one record", () => {
    expect(
      keys(foldAuditEntries([entry("a", 0), entry("b", 4), entry("c", 9)])),
    ).toEqual([["a", "b", "c"]]);
  });

  // Each break keeps a distinct event readable on its own row.
  it("keeps edits apart across actor, client, record, action and time gaps", () => {
    expect(
      keys(
        foldAuditEntries([
          entry("a", 0),
          entry("b", 1, { userId: "user-b" }),
          entry("c", 2, {
            userId: "user-b",
            runId: runShortcode.parse("RUN-4K7M"),
          }),
          entry("d", 3, { userId: "user-b", entityId: "PRD-7K4M" }),
          entry("e", 4, {
            userId: "user-b",
            entityId: "PRD-7K4M",
            action: "create",
          }),
          entry("f", 30),
          entry("g", 35),
        ]),
      ),
    ).toEqual([["a"], ["b"], ["c"], ["d"], ["e"], ["f", "g"]]);
  });
});
