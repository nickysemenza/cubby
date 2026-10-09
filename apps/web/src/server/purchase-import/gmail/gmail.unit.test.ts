import { describe, expect, it } from "vitest";

import { createGmailApiClient } from "./client";
import { normalizeHistoryPage, normalizeMessage } from "./normalize";
import { maxHistoryId } from "./sync";
import type { GmailMessage } from "./types";

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

  it("retries a transient Gmail 429 and honors Retry-After", async () => {
    let calls = 0;
    const waits: number[] = [];
    const client = createGmailApiClient({
      accessToken: "token-placeholder",
      sleep: async (ms) => {
        waits.push(ms);
      },
      fetcher: async () => {
        calls += 1;
        return calls === 1
          ? new Response("{}", {
              status: 429,
              headers: { "Retry-After": "2" },
            })
          : Response.json({ messages: [] });
      },
    });
    await expect(
      client.listMessages({ query: "from:example.test" }),
    ).resolves.toEqual({ messages: [] });
    expect(calls).toBe(2);
    expect(waits).toEqual([2_000]);
  });
});

describe("Gmail history cursor", () => {
  it("never regresses when a provider reports an older history id", () => {
    expect(maxHistoryId("100", "99")).toBe("100");
    expect(maxHistoryId("100", "101")).toBe("101");
    expect(maxHistoryId(null, undefined)).toBeNull();
  });
});
