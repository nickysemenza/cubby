/** An attachment lost after listing must still reach capable relevance; provider
 * outages and revoked authentication must remain recoverable failures. */
import { describe, expect, it, vi } from "vitest";

import { INLINE_EMAIL_PNG_BASE64 } from "./email-html.fixtures";
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
  it("counts a referenced inline image as available only when its exact MIME part reaches the interpreter", async () => {
    const png = INLINE_EMAIL_PNG_BASE64;
    const make = (
      contentId: string,
      filename: string | null = "logo.png",
      reference = "synthetic-logo%40example.test",
    ) =>
      normalizeMessage("synthetic-mailbox", {
        id: "synthetic-inline-source",
        payload: {
          parts: [
            {
              mimeType: "text/html",
              body: {
                data: Buffer.from(
                  `<p>Community newsletter with gardening tips and upcoming neighborhood events.</p><img src="cid:${reference}"><img src="cid:${reference}">`,
                ).toString("base64url"),
              },
            },
            {
              mimeType: "image/png",
              filename: filename ?? undefined,
              headers: [{ name: "Content-ID", value: `<${contentId}>` }],
              body: {
                data: Buffer.from(png, "base64").toString("base64url"),
                size: Buffer.from(png, "base64").length,
              },
            },
          ],
        },
      });
    const interpret = vi.fn<MailRelevance>(async () => ({
      classification: "unrelated",
      imageReadability: "sufficient",
    }));
    await expect(
      interpretMailRelevance(
        gmail(500),
        make("synthetic-logo@example.test"),
        interpret,
      ),
    ).resolves.toMatchObject({ classification: "unrelated" });
    expect(JSON.stringify(interpret.mock.calls[0]?.[0].messages)).toContain(
      '"mimeType":"image/jpeg"',
    );
    await expect(
      interpretMailRelevance(
        gmail(500),
        make("synthetic-logo@example.test", null),
        interpret,
      ),
    ).resolves.toMatchObject({ classification: "unrelated" });
    const longId = "synthetic-" + "x".repeat(520) + "@example.test";
    await expect(
      interpretMailRelevance(
        gmail(500),
        make(longId, "logo.png", longId),
        interpret,
      ),
    ).resolves.toMatchObject({ classification: "uncertain" });
    await expect(
      interpretMailRelevance(
        gmail(500),
        make(
          "synthetic-logo%ZZ@example.test",
          "logo.png",
          "synthetic-logo%ZZ@example.test",
        ),
        interpret,
      ),
    ).resolves.toMatchObject({ classification: "uncertain" });
    await expect(
      interpretMailRelevance(
        gmail(500),
        make("different-logo@example.test"),
        interpret,
      ),
    ).resolves.toMatchObject({ classification: "uncertain" });
    await expect(
      interpretMailRelevance(
        gmail(500),
        make("synthetic-logo@example.test"),
        interpret,
        false,
      ),
    ).resolves.toMatchObject({ classification: "uncertain" });
    const oversized = make("synthetic-logo@example.test");
    oversized.attachments = oversized.attachments.map((part) => ({
      ...part,
      size: 256 * 1024,
      dataBase64Url: Buffer.alloc(256 * 1024).toString("base64url"),
    }));
    await expect(
      interpretMailRelevance(gmail(500), oversized, interpret),
    ).resolves.toMatchObject({ classification: "uncertain" });
    const unavailable = make("synthetic-logo@example.test");
    unavailable.attachments = unavailable.attachments.map((part) => ({
      ...part,
      attachmentId: "synthetic-unavailable",
      dataBase64Url: undefined,
    }));
    await expect(
      interpretMailRelevance(gmail(404), unavailable, interpret),
    ).resolves.toMatchObject({ classification: "uncertain" });
    const missing = make("synthetic-logo@example.test");
    missing.attachments = [];
    await expect(
      interpretMailRelevance(gmail(404), missing, interpret),
    ).resolves.toMatchObject({ classification: "uncertain" });
  });

  it("accepts an unrelated newsletter verdict despite decorative images", async () => {
    const normalized = {
      ...original,
      attachments: [],
      mail: {
        ...original.mail,
        bodyText:
          "Community newsletter: the spring meetup moves to the town hall. Read our latest gardening tips and upcoming events.",
        bodyHtml:
          '<p>Community newsletter: the spring meetup moves to the town hall. Read our latest gardening tips and upcoming events.</p><img src="https://newsletter.example.test/logo.png" alt="Community garden logo">',
      },
    };
    await expect(
      interpretMailRelevance(gmail(500), normalized, async () => ({
        classification: "unrelated",
      })),
    ).resolves.toEqual({ classification: "unrelated" });
  });
  it("supplies fixed-pixel labels before accepting a verdict and keeps clipped labels uncertain", async () => {
    const make = (label: string) => ({
      ...original,
      attachments: [],
      mail: {
        ...original.mail,
        bodyText:
          "Community newsletter with gardening tips and upcoming events.",
        bodyHtml: `<p>Community newsletter with gardening tips and upcoming events.</p><div style="display:none"><img width="1" height="1" src="https://example.test/open.gif" alt="${label}"></div>`,
      },
    });
    for (const [label, classification] of [
      ["Free shipping on orders over $50", "unrelated"],
      ["Your purchase is confirmed. Order #SYN-7788 paid $24", "related"],
    ] as const) {
      const interpret = vi.fn<MailRelevance>(async () => ({ classification }));
      await expect(
        interpretMailRelevance(gmail(500), make(label), interpret),
      ).resolves.toEqual({ classification });
      expect(JSON.stringify(interpret.mock.calls[0]?.[0].messages)).toContain(
        label,
      );
    }
    await expect(
      interpretMailRelevance(
        gmail(500),
        make("x".repeat(800) + " Receipt"),
        async () => ({ classification: "unrelated" }),
      ),
    ).resolves.toEqual({ classification: "uncertain" });
  });

  it("keeps unresolved inline image pixels and truncated preheaders uncertain", async () => {
    for (const bodyHtml of [
      '<p>Community newsletter with gardening tips and upcoming events.</p><div style="display:none"><img src="https://shop.example.test/receipt.png" alt="Receipt total $24"></div>',
      '<p>Community newsletter with gardening tips and upcoming events.</p><div style="display:none">Receipt for order #SYN-12345</div>',
      '<img src="data:image/png;base64,c3ludGhldGlj">',
      `<div style="display:none">${"x".repeat(1200)} Receipt for order #SYN-12345</div><p>Community newsletter with gardening tips and the upcoming neighborhood events.</p>`,
    ]) {
      await expect(
        interpretMailRelevance(
          gmail(500),
          {
            ...original,
            attachments: [],
            mail: { ...original.mail, bodyText: "", bodyHtml },
          },
          async () => ({ classification: "unrelated" }),
        ),
      ).resolves.toEqual({ classification: "uncertain" });
    }
  });

  it("shows hidden account links to the interpreter before accepting a negative", async () => {
    const interpret = vi.fn<MailRelevance>(async () => ({
      classification: "unrelated",
    }));
    const result = await interpretMailRelevance(
      gmail(500),
      {
        ...original,
        attachments: [],
        mail: {
          ...original.mail,
          bodyText: "",
          bodyHtml:
            '<p>Community newsletter with gardening tips and upcoming events.</p><a style="display:none" href="https://shop.example.test/receipt">Learn more</a>',
        },
      },
      interpret,
    );
    expect(JSON.stringify(interpret.mock.calls[0]?.[0].messages)).toContain(
      "https://shop.example.test/receipt",
    );
    expect(JSON.stringify(interpret.mock.calls[0]?.[0].messages)).toContain(
      "Learn more",
    );
    expect(result).toEqual({ classification: "unrelated" });
  });

  it("includes hidden preheader order evidence in the relevance request", async () => {
    let evidence = "";
    await interpretMailRelevance(
      gmail(500),
      {
        ...original,
        attachments: [],
        mail: {
          ...original.mail,
          bodyText: "",
          bodyHtml:
            '<div style="display:none">Receipt for order #SYN-12345</div><p>See the latest updates in your account.</p>',
        },
      },
      async (request) => {
        evidence = JSON.stringify(request.messages);
        return { classification: "related" };
      },
    );
    expect(evidence).toContain("Receipt for order #SYN-12345");
  });

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
  it("preserves structured order evidence behind a generic visible notification", async () => {
    const normalized = {
      ...original,
      attachments: [],
      mail: {
        ...original.mail,
        bodyText: "Your account has an update",
        bodyHtml:
          '<p>Your account has an update</p><script type="application/ld+json">{"@type":"Order","orderNumber":"synthetic-order","orderedItem":{"name":"Synthetic basil plant"}}</script>',
      },
    };
    const interpret = vi.fn<MailRelevance>(async (request) => ({
      classification: JSON.stringify(request).includes("synthetic-order")
        ? "related"
        : "unrelated",
    }));
    await expect(
      interpretMailRelevance(gmail(500), normalized, interpret),
    ).resolves.toEqual({ classification: "related" });
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
    ).resolves.toEqual({
      classification: "uncertain",
      reason: "Original model input exceeds the Email relevance byte budget",
    });
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
      interpretMailRelevance(
        gmail(500),
        normalized,
        interpret,
        true,
        undefined,
        {
          fetcher: async () => new Response(null, { status: 404 }),
        },
      ),
    ).resolves.toMatchObject({ classification: "uncertain" });
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
