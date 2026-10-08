/** Plausible failures: gather-all blocks progress; scoped completion skips archives;
 * history advances before the last page; expired history resumes only recent mail;
 * scans starve newly arriving mail; unrelated or unreadable mail is archived. */
import { describe, expect, it, vi } from "vitest";

import {
  initializeMailboxCoverage,
  listGmailPage,
  mergeMailboxQueries,
} from "./sync";
import { GmailApiError, type GmailProvider } from "./types";

const gmail = (overrides: Partial<GmailProvider> = {}): GmailProvider => ({
  getProfile: async () => ({ historyId: "100" }),
  listMessages: async () => ({ messages: [] }),
  getMessage: async (id) => ({ id }),
  listHistory: async () => ({ historyId: "110" }),
  getAttachment: async () => ({}),
  ...overrides,
});

describe("durable Gmail page acquisition", () => {
  it("does not enumerate retained history for new-mail discovery", async () => {
    const listMessages = vi.fn(async () => ({ messages: [{ id: "old" }] }));
    const listHistory = vi.fn(async () => ({ historyId: "110" }));
    const provider = gmail({ listMessages, listHistory });
    const coverage = await initializeMailboxCoverage(provider, [
      { key: "vendor", query: "forge" },
    ]);
    const page = await listGmailPage(provider, "google-subject", coverage);
    expect(listMessages).not.toHaveBeenCalled();
    expect(listHistory).toHaveBeenCalledOnce();
    expect(page.nextCoverage.broad).toEqual(coverage.broad);
    expect(page.nextCoverage.scoped).toEqual(coverage.scoped);
  });

  it("does not turn an expired new-mail cursor into an unapproved full-history scan", async () => {
    const listMessages = vi.fn(async () => ({ messages: [] }));
    const provider = gmail({
      listMessages,
      listHistory: async () => {
        throw new GmailApiError({
          status: 404,
          message: "Synthetic expired history",
        });
      },
    });
    const coverage = await initializeMailboxCoverage(provider, []);
    coverage.nextLane = "history";
    await expect(
      listGmailPage(provider, "google-subject", coverage),
    ).rejects.toThrow(/expired history/);
    expect(listMessages).not.toHaveBeenCalled();
  });

  it("captures a baseline, reads one prioritized page, then catches new mail before continuing", async () => {
    const calls: string[] = [];
    const provider = gmail({
      getProfile: async () => {
        calls.push("baseline");
        return { historyId: "100" };
      },
      listMessages: async ({ query }) => {
        calls.push(query);
        return { messages: [{ id: "archived" }], nextPageToken: "page-two" };
      },
      listHistory: async ({ startHistoryId }) => {
        calls.push(`history:${startHistoryId}`);
        return {
          historyId: "110",
          history: [{ id: "109", messagesAdded: [{ message: { id: "new" } }] }],
        };
      },
    });
    const coverage = await initializeMailboxCoverage(provider, [
      { key: "vendor", query: "{forge from:platform.example}" },
    ]);
    const page = await listGmailPage(
      provider,
      "google-subject",
      coverage,
      "all_history",
    );
    expect(calls).toEqual([
      "baseline",
      "({forge from:platform.example}) -in:spam -in:trash",
    ]);
    expect(page.messageIds).toEqual(["archived"]);
    expect(page.nextCoverage.broad).toEqual({
      pageToken: null,
      completed: false,
    });
    const recent = await listGmailPage(
      provider,
      "google-subject",
      page.nextCoverage,
      "all_history",
    );
    expect(recent.messageIds).toEqual(["new"]);
    expect(recent.nextCoverage.scoped[0]?.pageToken).toBe("page-two");
    expect(recent.nextCoverage.history.historyId).toBe("110");
  });

  it("whole history is unbounded by date and scoped completion never completes it", async () => {
    const listMessages = vi.fn(
      async (_request: Parameters<GmailProvider["listMessages"]>[0]) => ({
        messages: [],
      }),
    );
    const provider = gmail({ listMessages });
    const coverage = await initializeMailboxCoverage(provider, [
      { key: "charge", query: '"FORGE"' },
    ]);
    const scoped = await listGmailPage(
      provider,
      "google-subject",
      coverage,
      "all_history",
    );
    expect(scoped.nextCoverage.scoped[0]?.completed).toBe(true);
    expect(scoped.nextCoverage.broad.completed).toBe(false);
    const history = await listGmailPage(
      provider,
      "google-subject",
      scoped.nextCoverage,
      "all_history",
    );
    await listGmailPage(
      provider,
      "google-subject",
      history.nextCoverage,
      "all_history",
    );
    expect(listMessages.mock.calls.at(-1)?.[0]).toMatchObject({
      query: "-in:spam -in:trash",
      maxResults: 25,
    });
  });

  it("checkpoints history page tokens without advancing its start until all history pages are processed", async () => {
    const provider = gmail({
      listHistory: async () => ({
        historyId: "120",
        nextPageToken: "history-two",
      }),
    });
    const coverage = await initializeMailboxCoverage(provider, []);
    coverage.nextLane = "history";
    const page = await listGmailPage(
      provider,
      "google-subject",
      coverage,
      "all_history",
    );
    expect(page.nextCoverage.history).toEqual({
      historyId: "100",
      pageToken: "history-two",
      targetHistoryId: "120",
    });
  });

  it("an expired history cursor recovers via full enumeration, preserving scoped positions", async () => {
    const provider = gmail({
      getProfile: async () => ({ historyId: "200" }),
      listHistory: async () => {
        throw new GmailApiError({ status: 404, message: "expired" });
      },
    });
    const coverage = await initializeMailboxCoverage(provider, [
      { key: "vendor", query: "forge" },
    ]);
    coverage.nextLane = "history";
    coverage.broad = { pageToken: "old-page", completed: true };
    const page = await listGmailPage(
      provider,
      "google-subject",
      coverage,
      "all_history",
    );
    expect(page.messageIds).toEqual([]);
    expect(page.nextCoverage.broad).toEqual({
      pageToken: null,
      completed: false,
    });
    expect(page.nextCoverage.baselineHistoryId).toBe("200");
    expect(page.nextCoverage.scoped).toEqual(coverage.scoped);
  });
  it("adds new scoped objectives while preserving broad and existing scoped checkpoints", async () => {
    const coverage = await initializeMailboxCoverage(gmail(), [
      { key: "vendor", query: "forge" },
    ]);
    coverage.scoped[0]!.pageToken = "scoped-two";
    coverage.broad.pageToken = "broad-five";
    const updated = mergeMailboxQueries(coverage, [
      { key: "vendor", query: "forge" },
      { key: "charge", query: "platform" },
    ]);
    expect(updated.broad.pageToken).toBe("broad-five");
    expect(updated.scoped).toEqual([
      {
        key: "vendor",
        query: "forge",
        pageToken: "scoped-two",
        completed: false,
      },
      { key: "charge", query: "platform", pageToken: null, completed: false },
    ]);
  });
});
