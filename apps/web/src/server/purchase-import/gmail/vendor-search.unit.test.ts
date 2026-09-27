import { describe, expect, it, vi } from "vitest";

import type { GmailMessage, GmailProvider } from "./types";
import { loadVendorMailPage } from "./vendor-search";

const message = (id: string, from: string): GmailMessage => ({
  id,
  internalDate: "1789156800000",
  payload: {
    headers: [
      { name: "From", value: from },
      { name: "Subject", value: "Your order" },
    ],
  },
});

describe("on-demand Vendor Gmail search", () => {
  it("uses the website domain, bounds a page, and rejects unrelated senders", async () => {
    const listMessages = vi.fn(async () => ({
      messages: [{ id: "mail-a" }, { id: "mail-decoy" }],
      nextPageToken: "next-page",
    }));
    const provider: GmailProvider = {
      getProfile: async () => ({ historyId: "100" }),
      listMessages,
      getMessage: async (id) =>
        id === "mail-a"
          ? message(id, "Orders <receipts@notify.example-outfitters.co.uk>")
          : message(id, "Orders <other@fake-example-outfitters.co.uk>"),
      listHistory: async () => ({ history: [] }),
      getAttachment: async () => ({ data: "" }),
    };
    const result = await loadVendorMailPage(provider, {
      identity: {
        website: "https://shop.example-outfitters.co.uk",
        orderEmailSenders: [],
      },
      after: "2025/09/01",
      pageToken: null,
    });

    expect(listMessages).toHaveBeenCalledWith({
      query: "from:example-outfitters.co.uk after:2025/09/01",
      maxResults: 10,
    });
    expect(result.messages.map((mail) => mail.messageId)).toEqual(["mail-a"]);
    expect(result.nextPageToken).toBe("next-page");
    expect(result.searched).toBe(2);
  });

  it("skips previously saved Gmail ids before fetching message bodies", async () => {
    const getMessage = vi.fn(async (id: string) =>
      message(id, "Orders <orders@example.test>"),
    );
    const provider: GmailProvider = {
      getProfile: async () => ({ historyId: "100" }),
      listMessages: async () => ({
        messages: [{ id: "saved" }, { id: "new" }],
      }),
      getMessage,
      listHistory: async () => ({ history: [] }),
      getAttachment: async () => ({ data: "" }),
    };
    const result = await loadVendorMailPage(provider, {
      identity: { website: "https://example.test", orderEmailSenders: [] },
      after: "2025/09/01",
      pageToken: null,
      knownMessageIds: async () => new Set(["saved"]),
    });
    expect(getMessage).toHaveBeenCalledTimes(1);
    expect(getMessage).toHaveBeenCalledWith("new");
    expect(result.skipped).toBe(1);
  });
});
