import { describe, expect, it } from "vitest";

import { createGmailApiClient } from "./client";
import { normalizeHistoryPage, normalizeMessage } from "./normalize";
import {
  advanceGmailCursor,
  buildBootstrapPlan,
  syncGmailMailbox,
} from "./sync";
import { GmailApiError, type GmailMessage, type GmailProvider } from "./types";

const NOW = new Date("2026-09-19T12:00:00.000Z");

const orderMessage = (
  id: string,
  internalDate = "1789819200000",
): GmailMessage => ({
  id,
  threadId: `thread-${id}`,
  historyId: "101",
  internalDate,
  labelIds: ["INBOX", "CATEGORY_UPDATES", "INBOX"],
  snippet: `Order ${id}`,
  payload: {
    mimeType: "multipart/mixed",
    headers: [
      { name: "Subject", value: `Order ${id}` },
      { name: "From", value: "orders@example.test" },
      { name: "X-Tag", value: "one" },
      { name: "x-tag", value: "two" },
    ],
    parts: [
      {
        partId: "plain",
        mimeType: "text/plain",
        body: { data: "SGVsbG8gZnJvbSB0aGUgc2VuZGVy" },
      },
      {
        partId: "html",
        mimeType: "text/html",
        body: { data: "PGI+SGVsbG88L2I+" },
      },
      {
        partId: "receipt",
        filename: "receipt.pdf",
        mimeType: "application/pdf",
        body: { attachmentId: `attachment-${id}`, size: 3 },
      },
    ],
  },
});

const providerWith = (
  overrides: Partial<GmailProvider> = {},
): GmailProvider => ({
  getProfile: async () => ({ historyId: "100" }),
  listMessages: async () => ({ messages: [] }),
  getMessage: async (messageId) => orderMessage(messageId),
  listHistory: async () => ({ historyId: "100", history: [] }),
  getAttachment: async () => ({ data: "YWJj", size: 3 }),
  ...overrides,
});

describe("Gmail normalization", () => {
  it("normalizes a multipart message and keeps attachment identity stable", () => {
    const result = normalizeMessage("mailbox-placeholder", orderMessage("m-1"));

    expect(result.mail).toMatchObject({
      sourceKey: "gmail:mailbox-placeholder:m-1",
      messageId: "m-1",
      threadId: "thread-m-1",
      internalDate: "2026-09-19T12:00:00.000Z",
      labelIds: ["CATEGORY_UPDATES", "INBOX"],
      snippet: "Order m-1",
      bodyText: "Hello from the sender",
      bodyHtml: "<b>Hello</b>",
    });
    expect(result.mail.headers).toEqual({
      from: "orders@example.test",
      subject: "Order m-1",
      "x-tag": "one, two",
    });
    expect(result.attachments).toEqual([
      {
        sourceKey: "gmail:mailbox-placeholder:m-1:attachment:receipt",
        mailboxId: "mailbox-placeholder",
        messageId: "m-1",
        attachmentId: "attachment-m-1",
        filename: "receipt.pdf",
        mimeType: "application/pdf",
        size: 3,
      },
    ]);
  });

  it("normalizes every history mutation, including deletes without a message fetch", () => {
    const events = normalizeHistoryPage("mailbox-placeholder", {
      history: [
        {
          id: "12",
          messagesAdded: [{ message: { id: "m-added", threadId: "t-added" } }],
          messagesDeleted: [{ message: { id: "m-deleted" } }],
          labelsAdded: [
            { message: { id: "m-labeled" }, labelIds: ["STARRED", "STARRED"] },
          ],
          labelsRemoved: [
            { message: { id: "m-labeled" }, labelIds: ["INBOX"] },
          ],
        },
      ],
    });

    expect(events).toEqual([
      {
        sourceKey: "gmail:mailbox-placeholder:history:12:0",
        mailboxId: "mailbox-placeholder",
        historyId: "12",
        messageId: "m-added",
        threadId: "t-added",
        kind: "message_added",
        labelIds: [],
      },
      {
        sourceKey: "gmail:mailbox-placeholder:history:12:1",
        mailboxId: "mailbox-placeholder",
        historyId: "12",
        messageId: "m-deleted",
        threadId: null,
        kind: "message_deleted",
        labelIds: [],
      },
      {
        sourceKey: "gmail:mailbox-placeholder:history:12:2",
        mailboxId: "mailbox-placeholder",
        historyId: "12",
        messageId: "m-labeled",
        threadId: null,
        kind: "labels_added",
        labelIds: ["STARRED"],
      },
      {
        sourceKey: "gmail:mailbox-placeholder:history:12:3",
        mailboxId: "mailbox-placeholder",
        historyId: "12",
        messageId: "m-labeled",
        threadId: null,
        kind: "labels_removed",
        labelIds: ["INBOX"],
      },
    ]);
  });
});

describe("Gmail API client", () => {
  it("uses the bearer token and deterministic Gmail resource paths", async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    const client = createGmailApiClient({
      accessToken: "token-placeholder",
      baseUrl: "https://gmail.test/v1/",
      fetcher: async (input, init) => {
        const url = String(input);
        requests.push({ url, init });
        if (url.includes("/profile")) return Response.json({ historyId: "90" });
        if (url.includes("/messages?")) return Response.json({ messages: [] });
        if (url.includes("/history?"))
          return Response.json({ historyId: "91" });
        if (url.includes("/attachments/"))
          return Response.json({ data: "YWJj" });
        return Response.json(orderMessage("m-api"));
      },
    });

    await client.getProfile();
    await client.listMessages({
      query: "from:orders@example.test",
      maxResults: 25,
    });
    await client.getMessage("message/id");
    await client.listHistory({ startHistoryId: "90", maxResults: 25 });
    await client.getAttachment("message/id", "attachment/id");

    expect(requests.map(({ url }) => url)).toEqual([
      "https://gmail.test/v1/users/me/profile",
      "https://gmail.test/v1/users/me/messages?maxResults=25&q=from%3Aorders%40example.test",
      "https://gmail.test/v1/users/me/messages/message%2Fid?format=full",
      "https://gmail.test/v1/users/me/history?maxResults=25&startHistoryId=90",
      "https://gmail.test/v1/users/me/messages/message%2Fid/attachments/attachment%2Fid",
    ]);
    for (const { init } of requests) {
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer token-placeholder",
      );
    }
  });

  it("preserves Gmail's reason and status for history expiry", async () => {
    const client = createGmailApiClient({
      accessToken: "token-placeholder",
      fetcher: async () =>
        new Response(
          JSON.stringify({
            error: {
              message: "History id is too old",
              errors: [{ reason: "historyIdInvalid" }],
            },
          }),
          { status: 404, statusText: "Not Found" },
        ),
    });

    await expect(
      client.listHistory({ startHistoryId: "1" }),
    ).rejects.toMatchObject({
      name: "GmailApiError",
      status: 404,
      reason: "historyIdInvalid",
      message: "History id is too old",
    });
  });
});

describe("Gmail synchronization", () => {
  it("builds deterministic bootstrap queries", () => {
    expect(
      buildBootstrapPlan({
        knownSenders: [
          " Orders@example.test ",
          "alerts@example.test",
          "orders@example.test",
        ],
        earliestUnresolvedHuntAt: new Date("2026-09-10T22:00:00.000Z"),
        now: NOW,
      }),
    ).toEqual({
      knownSenderQueries: [
        "from:alerts@example.test after:2026-09-03",
        "from:orders@example.test after:2026-09-03",
      ],
      unknownOrderQuery: "after:2026-08-20",
    });
  });

  it("bootstraps from a profile baseline and advances only after all pages finish", async () => {
    const requestedQueries: string[] = [];
    const provider = providerWith({
      getProfile: async () => ({ historyId: "100" }),
      listMessages: async ({ query, pageToken }) => {
        requestedQueries.push(`${query}:${pageToken ?? "first"}`);
        if (pageToken) return { messages: [{ id: "m-2" }] };
        return {
          messages: [{ id: "m-2" }, { id: "m-1" }],
          nextPageToken: "next",
        };
      },
      getMessage: async (messageId) => orderMessage(messageId),
      getAttachment: async () => ({ data: "YWJj", size: 3 }),
    });

    const result = await syncGmailMailbox(provider, {
      mailboxId: "mailbox-placeholder",
      cursor: { historyId: null },
      bootstrap: { knownSenders: ["orders@example.test"], now: NOW },
      includeAttachmentData: true,
      maxResults: 50,
    });

    expect(result.mode).toBe("bootstrap");
    expect(result.reason).toBe("first_sync");
    expect(result.cursor).toEqual({ historyId: "100" });
    expect(result.messages.map((message) => message.messageId)).toEqual([
      "m-1",
      "m-2",
    ]);
    expect(
      result.attachments.every(
        (attachment) => attachment.dataBase64Url === "YWJj",
      ),
    ).toBe(true);
    expect(requestedQueries).toHaveLength(4);
    expect(
      new Set(requestedQueries.map((query) => query.split(":")[0])),
    ).toEqual(new Set(["from", "after"]));
  });

  it("advances an incremental cursor through pages and fetches each changed message once", async () => {
    const fetched: string[] = [];
    const provider = providerWith({
      listHistory: async ({ pageToken }) =>
        pageToken
          ? {
              historyId: "103",
              history: [
                {
                  id: "103",
                  messagesDeleted: [{ message: { id: "m-deleted" } }],
                },
              ],
            }
          : {
              historyId: "102",
              nextPageToken: "next",
              history: [
                {
                  id: "102",
                  messagesAdded: [
                    {
                      message: {
                        id: "m-changed",
                        threadId: "thread-m-changed",
                      },
                    },
                  ],
                  labelsAdded: [
                    { message: { id: "m-changed" }, labelIds: ["INBOX"] },
                  ],
                },
              ],
            },
      getMessage: async (messageId) => {
        fetched.push(messageId);
        return orderMessage(messageId);
      },
    });

    const result = await syncGmailMailbox(provider, {
      mailboxId: "mailbox-placeholder",
      cursor: { historyId: "100" },
      bootstrap: { knownSenders: [], now: NOW },
    });

    expect(result.mode).toBe("incremental");
    expect(result.cursor).toEqual({ historyId: "103" });
    expect(result.events.map((event) => event.kind)).toEqual([
      "message_added",
      "labels_added",
      "message_deleted",
    ]);
    expect(fetched).toEqual(["m-changed"]);
  });

  it("falls back to a full resync when Gmail expires the history cursor", async () => {
    let historyCalls = 0;
    const provider = providerWith({
      getProfile: async () => ({ historyId: "200" }),
      listHistory: async () => {
        historyCalls += 1;
        throw new GmailApiError({
          status: 404,
          reason: "historyIdInvalid",
          message: "History id is too old",
        });
      },
      listMessages: async ({ query }) =>
        query.startsWith("after:")
          ? { messages: [{ id: "m-recovered" }] }
          : { messages: [] },
    });

    const result = await syncGmailMailbox(provider, {
      mailboxId: "mailbox-placeholder",
      cursor: { historyId: "1" },
      bootstrap: { knownSenders: [], now: NOW },
    });

    expect(historyCalls).toBe(1);
    expect(result.mode).toBe("full_resync");
    expect(result.reason).toBe("history_expired");
    expect(result.cursor).toEqual({ historyId: "200" });
    expect(result.messages.map((message) => message.messageId)).toEqual([
      "m-recovered",
    ]);
  });

  it("never regresses a cursor when a provider reports an older history id", () => {
    expect(advanceGmailCursor({ historyId: "100" }, "99")).toEqual({
      historyId: "100",
    });
    expect(advanceGmailCursor({ historyId: "100" }, "101")).toEqual({
      historyId: "101",
    });
    expect(advanceGmailCursor({ historyId: null }, undefined)).toEqual({
      historyId: null,
    });
  });
});
