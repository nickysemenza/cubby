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
  it("omits HTML layout bytes while keeping original visible order content and exact links", async () => {
    const normalized = {
      ...original,
      attachments: [],
      mail: {
        ...original.mail,
        bodyText: "Order confirmed: Synthetic basil plant",
        bodyHtml: `<html><head><style>${".layout{color:red}".repeat(20_000)}</style></head><body><p>Order confirmed: Synthetic basil plant</p><a href="https://merchant.example.test/orders/exact-order">View order</a></body></html>`,
      },
    };
    const before = JSON.stringify(normalized);
    const interpret = vi.fn<MailRelevance>(async () => ({
      classification: "related",
    }));
    await expect(
      interpretMailRelevance(gmail(500), normalized, interpret),
    ).resolves.toEqual({ classification: "related" });
    const request = JSON.stringify(interpret.mock.calls[0]?.[0]);
    expect(request).toContain("Synthetic basil plant");
    expect(request).toContain(
      "https://merchant.example.test/orders/exact-order",
    );
    expect(request.includes(".layout")).toBe(false);
    expect(request.length).toBeLessThan(4_000);
    expect(JSON.stringify(normalized)).toBe(before);
  });
  it("routes oversized readable mail as uncertain without spending inference on an incomplete excerpt", async () => {
    const normalized = {
      ...original,
      attachments: [],
      mail: {
        ...original.mail,
        bodyText: "Purchase evidence ".repeat(20_000),
        bodyHtml: null,
      },
    };
    const interpret = vi.fn<MailRelevance>(async () => ({
      classification: "unrelated",
    }));
    await expect(
      interpretMailRelevance(gmail(500), normalized, interpret),
    ).resolves.toEqual({ classification: "uncertain" });
    expect(interpret).not.toHaveBeenCalled();
  });
  it("accounts for inline attachment encoding before admitting model content and keeps omitted evidence uncertain", async () => {
    const normalized = {
      ...original,
      mail: {
        ...original.mail,
        bodyText: "Synthetic order confirmed",
        bodyHtml: null,
      },
      attachments: original.attachments.map((attachment) => ({
        ...attachment,
        size: 200 * 1024,
        dataBase64Url: Buffer.alloc(200 * 1024).toString("base64url"),
      })),
    };
    const interpret = vi.fn<MailRelevance>(async () => ({
      classification: "unrelated",
    }));
    await expect(
      interpretMailRelevance(gmail(500), normalized, interpret),
    ).resolves.toEqual({ classification: "uncertain" });
    expect(
      new TextEncoder().encode(
        JSON.stringify(interpret.mock.calls[0]?.[0]?.messages),
      ).byteLength,
    ).toBeLessThanOrEqual(256 * 1024);
  });
  it("preserves available attachment-only original bytes even when the model view omits them", async () => {
    const encoded = Buffer.alloc(300 * 1024).toString("base64url");
    const normalized = {
      ...original,
      attachments: original.attachments.map((attachment) => ({
        ...attachment,
        size: 300 * 1024,
        dataBase64Url: encoded,
      })),
    };
    const retained = vi.fn();
    const interpret = vi.fn<MailRelevance>(async () => ({
      classification: "uncertain",
    }));
    await expect(
      interpretMailRelevance(gmail(500), normalized, interpret, true, retained),
    ).resolves.toEqual({ classification: "uncertain" });
    expect(retained).toHaveBeenCalledWith(
      normalized.attachments[0]?.sourceKey,
      encoded,
    );
    expect(
      JSON.stringify(interpret.mock.calls[0]?.[0]?.messages).length,
    ).toBeLessThan(256 * 1024);
  });
  it("keeps image-only HTML purchase evidence visible and refuses a negative verdict without image pixels", async () => {
    const normalized = {
      ...original,
      attachments: [],
      mail: {
        ...original.mail,
        bodyText: null,
        bodyHtml:
          '<p>Account notice</p><img src="https://merchant.example.test/receipt.png" alt="Paid receipt for Synthetic basil plant, total $24">',
      },
    };
    const interpret = vi.fn<MailRelevance>(async () => ({
      classification: "unrelated",
    }));
    await expect(
      interpretMailRelevance(gmail(500), normalized, interpret),
    ).resolves.toEqual({ classification: "uncertain" });
    const request = JSON.stringify(interpret.mock.calls[0]?.[0]?.messages);
    expect(request.includes("Paid receipt for Synthetic basil plant")).toBe(
      true,
    );
    expect(request.includes("https://merchant.example.test/receipt.png")).toBe(
      true,
    );
  });
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
