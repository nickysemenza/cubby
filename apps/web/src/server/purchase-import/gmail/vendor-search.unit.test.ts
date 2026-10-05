import { describe, expect, it, vi } from "vitest";

import type { GmailProvider } from "./types";
import { listVendorMailPage } from "./vendor-search";

describe("on-demand Vendor Gmail search", () => {
  it("searches the website domain, bounds a page, and fetches no message", async () => {
    const listMessages = vi.fn(async () => ({
      messages: Array.from({ length: 12 }, (_, index) => ({
        id: `mail-${index}`,
      })),
      nextPageToken: "next-page",
    }));
    const getMessage = vi.fn();
    const provider: GmailProvider = {
      getProfile: async () => ({ historyId: "100" }),
      listMessages,
      getMessage,
      listHistory: async () => ({ history: [] }),
      getAttachment: async () => ({ data: "" }),
    };
    const result = await listVendorMailPage(provider, {
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
    expect(result.messageIds).toHaveLength(10);
    expect(result.nextPageToken).toBe("next-page");
    expect(getMessage).not.toHaveBeenCalled();
  });
});
