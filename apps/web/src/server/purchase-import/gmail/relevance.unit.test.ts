/** An attachment lost after listing must still reach capable relevance; provider
 * outages and revoked authentication must remain recoverable failures. */
import { describe, expect, it, vi } from "vitest";

import { normalizeMessage } from "./normalize";
import { interpretMailRelevance, type MailRelevance } from "./relevance";
import { GmailApiError, type GmailProvider } from "./types";

const original = normalizeMessage("synthetic-google-subject", {
  id: "synthetic-source",
  payload: {
    headers: [{ name: "Subject", value: "Synthetic original context" }],
    parts: [
      {
        partId: "document",
        filename: "receipt.pdf",
        mimeType: "application/pdf",
        body: { attachmentId: "synthetic-part", size: 3 },
      },
    ],
  },
});
const gmail = (status: number): GmailProvider => ({
  getProfile: async () => ({ historyId: "100" }),
  listMessages: async () => ({}),
  listHistory: async () => ({}),
  getMessage: async (id) => ({ id }),
  getAttachment: async () => {
    throw new GmailApiError({
      status,
      message: "Synthetic unavailable attachment",
    });
  },
});

describe("transient original attachment relevance", () => {
  it("interprets a missing attachment and keeps a negative verdict uncertain because evidence is unreadable", async () => {
    const interpret = vi.fn<MailRelevance>(async () => ({
      classification: "unrelated",
    }));
    expect(
      await interpretMailRelevance(gmail(404), original, interpret),
    ).toEqual({ classification: "uncertain" });
    expect(interpret).toHaveBeenCalledTimes(1);
  });
  it("propagates other provider failures without manufacturing a negative classification", async () => {
    const interpret = vi.fn<MailRelevance>(async () => ({
      classification: "unrelated",
    }));
    await expect(
      interpretMailRelevance(gmail(500), original, interpret),
    ).rejects.toMatchObject({ status: 500 });
    expect(interpret).not.toHaveBeenCalled();
  });
});
