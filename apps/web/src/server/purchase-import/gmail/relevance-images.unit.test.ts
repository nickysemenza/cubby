/** Failures: remote receipt pixels never reach the model, tracking pixels cause
 * downloads, a detail retry downloads again, or missing pixels authorize a negative. */
import { describe, expect, it, vi } from "vitest";

import { INLINE_EMAIL_PNG_BASE64 } from "./email-html.fixtures";
import { normalizeMessage } from "./normalize";
import { interpretMailRelevance, type MailRelevance } from "./relevance";
import type { GmailProvider } from "./types";

const bytes = Buffer.from(INLINE_EMAIL_PNG_BASE64, "base64");
const provider: GmailProvider = {
  getProfile: async () => ({ historyId: "1" }),
  listMessages: async () => ({}),
  listHistory: async () => ({}),
  getMessage: async () => ({ id: "synthetic-source" }),
  getAttachment: async () => {
    throw new Error("No attachment expected");
  },
};
const original = normalizeMessage("synthetic-mailbox", {
  id: "synthetic-source",
  payload: {
    mimeType: "text/html",
    body: {
      data: Buffer.from(
        '<img src="https://example.test/content.png"><img src="https://example.test/pixel.gif" width="1" height="1">',
      ).toString("base64url"),
    },
  },
});
const imagePorts = () => ({
  fetcher: vi.fn(
    async () =>
      new Response(bytes, { headers: { "content-type": "image/png" } }),
  ),
  prepareImage: vi.fn(
    async (_bytes: Uint8Array, _detail: "standard" | "detail") => ({
      bytes,
      mimeType: "image/png",
    }),
  ),
});

describe("bounded Email image evidence", () => {
  it("supplies content pixels and excludes tracking pixels before accepting a negative", async () => {
    const ports = imagePorts();
    const interpret = vi.fn<MailRelevance>(async () => ({
      classification: "unrelated",
      imageReadability: "sufficient",
    }));
    const result = await interpretMailRelevance(
      provider,
      original,
      interpret,
      true,
      undefined,
      ports,
    );
    expect(result.classification).toBe("unrelated");
    expect(ports.fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(interpret.mock.calls[0]?.[0].messages)).toContain(
      INLINE_EMAIL_PNG_BASE64,
    );
    expect(result.reason).toContain("1/1 content images");
  });

  it("reuses acquired pixels for one detail retry and keeps a still-unreadable negative uncertain", async () => {
    const ports = imagePorts();
    const interpret = vi.fn<MailRelevance>(async () => ({
      classification: "unrelated",
      imageReadability: "needs_detail",
    }));
    const result = await interpretMailRelevance(
      provider,
      original,
      interpret,
      true,
      undefined,
      ports,
    );
    expect(result.classification).toBe("uncertain");
    expect(interpret).toHaveBeenCalledTimes(2);
    expect(ports.fetcher).toHaveBeenCalledTimes(1);
    expect(ports.prepareImage.mock.calls.map((call) => call[1])).toEqual([
      "standard",
      "detail",
    ]);
  });

  it("preserves a justified positive even when another image remains unreadable", async () => {
    const result = await interpretMailRelevance(
      provider,
      original,
      async () => ({
        classification: "related",
        imageReadability: "unreadable",
      }),
      true,
      undefined,
      imagePorts(),
    );
    expect(result.classification).toBe("related");
  });

  it.each([undefined, "unreadable", "needs_detail"] as const)(
    "guards original image fallbacks when readability is %s",
    async (imageReadability) => {
      const attached = normalizeMessage("synthetic-mailbox", {
        id: "synthetic-source",
        payload: {
          parts: [
            {
              mimeType: "image/png",
              filename: "synthetic.png",
              body: { data: bytes.toString("base64url"), size: bytes.length },
            },
          ],
        },
      });
      const ports = { fetcher: imagePorts().fetcher };
      const result = await interpretMailRelevance(
        provider,
        attached,
        async () => ({ classification: "unrelated", imageReadability }),
        true,
        undefined,
        ports,
      );
      expect(result.classification).toBe("uncertain");
    },
  );

  it("exhausts acquisition after an oversized streaming image instead of downloading the budget again", async () => {
    const ports = imagePorts();
    ports.fetcher.mockImplementation(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(3 * 1024 * 1024 + 1));
              controller.close();
            },
          }),
          { headers: { "content-type": "image/png" } },
        ),
    );
    const many = normalizeMessage("synthetic-mailbox", {
      id: "synthetic-source",
      payload: {
        mimeType: "text/html",
        body: {
          data: Buffer.from(
            '<img src="https://example.test/a.png"><img src="https://example.test/b.png">',
          ).toString("base64url"),
        },
      },
    });
    const result = await interpretMailRelevance(
      provider,
      many,
      async () => ({ classification: "unrelated" }),
      true,
      undefined,
      ports,
    );
    expect(result.classification).toBe("uncertain");
    expect(ports.fetcher).toHaveBeenCalledTimes(1);
  });

  it("resolves available CID logos before deciding whether readable mail needs remote pixels", async () => {
    const ports = imagePorts();
    const readable = normalizeMessage("synthetic-mailbox", {
      id: "synthetic-source",
      payload: {
        parts: [
          {
            mimeType: "text/html",
            body: {
              data: Buffer.from(
                '<p>Community newsletter: the spring meetup moves to the town hall. Read our latest gardening tips and upcoming events.</p><img src="cid:synthetic-logo"><img src="https://example.test/catalog.png">',
              ).toString("base64url"),
            },
          },
          {
            mimeType: "image/png",
            headers: [{ name: "Content-ID", value: "<synthetic-logo>" }],
            body: { data: bytes.toString("base64url"), size: bytes.length },
          },
        ],
      },
    });
    const result = await interpretMailRelevance(
      provider,
      readable,
      async () => ({
        classification: "unrelated",
        imageReadability: "sufficient",
      }),
      true,
      undefined,
      ports,
    );
    expect(result.classification).toBe("unrelated");
    expect(ports.fetcher).not.toHaveBeenCalled();
  });

  it("caps supplied attachment images and keeps the omitted seventh image uncertain", async () => {
    const ports = imagePorts();
    const many = normalizeMessage("synthetic-mailbox", {
      id: "synthetic-source",
      payload: {
        mimeType: "multipart/mixed",
        parts: Array.from({ length: 7 }, (_, i) => ({
          partId: String(i),
          filename: `synthetic-${i}.png`,
          mimeType: "image/png",
          body: { data: bytes.toString("base64url"), size: bytes.length },
        })),
      },
    });
    const interpret = vi.fn<MailRelevance>(async () => ({
      classification: "unrelated",
      imageReadability: "sufficient",
    }));
    const result = await interpretMailRelevance(
      provider,
      many,
      interpret,
      true,
      undefined,
      ports,
    );
    expect(result.classification).toBe("uncertain");
    const request = interpret.mock.calls[0]?.[0];
    expect(JSON.stringify(request).split(INLINE_EMAIL_PNG_BASE64)).toHaveLength(
      7,
    );
    expect(ports.prepareImage).toHaveBeenCalledTimes(6);
  });

  it("refuses private image destinations without fetching or authorizing a negative", async () => {
    const ports = imagePorts();
    const blocked = normalizeMessage("synthetic-mailbox", {
      id: "synthetic-source",
      payload: {
        mimeType: "text/html",
        body: {
          data: Buffer.from(
            '<img src="http://127.0.0.1/private.png">',
          ).toString("base64url"),
        },
      },
    });
    const result = await interpretMailRelevance(
      provider,
      blocked,
      async () => ({
        classification: "unrelated",
        imageReadability: "sufficient",
      }),
      true,
      undefined,
      ports,
    );
    expect(result.classification).toBe("uncertain");
    expect(ports.fetcher).not.toHaveBeenCalled();
  });

  it("keeps unavailable pixels incomplete and records remote failures without aborting the message", async () => {
    const ports = imagePorts();
    ports.fetcher.mockImplementation(
      async () => new Response(null, { status: 404 }),
    );
    const result = await interpretMailRelevance(
      provider,
      original,
      async () => ({ classification: "unrelated" }),
      true,
      undefined,
      ports,
    );
    expect(result.classification).toBe("uncertain");
    ports.fetcher.mockImplementation(
      async () => new Response("Synthetic outage", { status: 503 }),
    );
    const failed = await interpretMailRelevance(
      provider,
      original,
      async () => ({ classification: "unrelated" }),
      true,
      undefined,
      ports,
    );
    expect(failed.classification).toBe("uncertain");
    expect(failed.reason).toContain("503");
    expect(failed.reason).toContain("Synthetic outage");
  });
});
