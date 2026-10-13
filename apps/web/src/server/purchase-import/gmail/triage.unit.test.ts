/** Failures: missing originals classify negatively; a clipped amount, order
 * number, attachment, image-only body or dropped MIME part lets the decision model's
 * `unrelated` stand; HTML alone forces `uncertain`; escaping, Unicode or
 * transport headers push the view past the decision model's request gate. */
import * as recipebridge from "@cubby/recipebridge";
import { describe, expect, it, vi } from "vitest";

import { decisionChoiceFitsContext } from "~/server/ai/decision-model";

import {
  EMAIL_FIXTURE_SUMMARY,
  EMAIL_HTML_FIXTURES,
  summarizeEmailFixtures,
} from "./email-html.fixtures";
import { normalizeMessage } from "./normalize";
import { mailTriagePrompt, routeGmailMessage } from "./triage";
import type { GmailMessage, GmailMessagePart } from "./types";

const part = (body: string, mimeType = "text/plain"): GmailMessagePart => ({
  mimeType,
  body: {
    data: Buffer.from(body).toString("base64url"),
    size: Buffer.byteLength(body),
  },
});

const message = (body?: string, mimeType = "text/plain"): GmailMessage => ({
  id: "synthetic-mail",
  payload: {
    ...(body ? part(body, mimeType) : { mimeType, body: {} }),
    headers: [{ name: "Subject", value: "Payment" }],
  },
});

const route = async (
  raw: GmailMessage,
  choice: "related" | "unrelated" | "uncertain" = "unrelated",
) => {
  let content = "";
  const routed = await routeGmailMessage(
    raw,
    normalizeMessage("google-subject", raw),
    async (input) => {
      content = input;
      return choice;
    },
  );
  return { ...routed, content };
};

const withinGate = (content: string) =>
  decisionChoiceFitsContext(mailTriagePrompt(content));

describe("transient Gmail triage", () => {
  it("compacts the shared Email fixtures exactly as workerd does", () => {
    expect(summarizeEmailFixtures(recipebridge.compact_email_html)).toEqual(
      EMAIL_FIXTURE_SUMMARY,
    );
  });

  it("lets the decision model's unrelated stand for a complete HTML newsletter", async () => {
    const { decision, view, content } = await route(
      message(EMAIL_HTML_FIXTURES.newsletter, "text/html"),
    );
    expect(decision).toMatchObject({
      classification: "unrelated",
      stage: "decision",
    });
    expect(view).toMatchObject({ complete: true, incompleteReasons: [] });
    expect(JSON.parse(content)).toMatchObject({
      preheader: "Five things to plant before the frost",
      bodyComplete: true,
      omittedPurchaseCues: false,
    });
    expect(content).not.toContain("line-height");
  });

  it("keeps an order table's rows, ranked order links and structured data in the view", async () => {
    const { content, view } = await route(
      message(EMAIL_HTML_FIXTURES.orderTable, "text/html"),
      "related",
    );
    expect(content).toContain("Bamboo spatula set | 2 | $18.50");
    expect(JSON.parse(content).htmlEvidence.links[0]).toEqual({
      href: "https://carrier.example.test/track?id=1Z999SYN",
      text: "Track package",
    });
    expect(view?.complete).toBe(true);

    const jsonLd = await route(
      message(EMAIL_HTML_FIXTURES.jsonLdOrder, "text/html"),
      "related",
    );
    expect(JSON.parse(jsonLd.content).htmlEvidence.structuredData[0]).toContain(
      '"orderNumber": "EB-778201"',
    );
  });

  it("keeps an image-only receipt uncertain", async () => {
    const { decision, view } = await route(
      message(EMAIL_HTML_FIXTURES.imageOnlyReceipt, "text/html"),
    );
    expect(decision).toMatchObject({
      classification: "uncertain",
      stage: "rule",
    });
    expect(view?.incompleteReasons).toEqual(["image_only"]);
  });

  it("keeps a message whose purchase cue the gate clipped uncertain", async () => {
    const { decision, view, content } = await route(
      message(
        "Newsletter " +
          "filler ".repeat(4_000) +
          "Receipt for order #SYN-55123 total $42.00 " +
          "filler ".repeat(4_000),
      ),
    );
    expect(withinGate(content)).toBe(true);
    expect(content).not.toContain("$42.00");
    expect(JSON.parse(content)).toMatchObject({
      bodyComplete: false,
      omittedPurchaseCues: true,
    });
    expect(decision).toMatchObject({
      classification: "uncertain",
      stage: "rule",
    });
    expect(view?.incompleteReasons).toEqual(["purchase_cue_clipped"]);
  });

  // Amounts are scanned first, so an advertised price list used to fill the
  // cue bound and hide a receipt clipped from the middle.
  it("keeps a clipped message uncertain when its cues overflow the scan bound", async () => {
    const prices = Array.from(
      { length: 210 },
      (_, cents) =>
        `$${10 + Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`,
    ).join(" ");
    const { decision, view, content } = await route(
      message(
        `Weekly deals ${prices} ` +
          "filler ".repeat(4_000) +
          "Receipt for order #SYN-55123 total $42.00 " +
          "filler ".repeat(4_000),
      ),
    );
    expect(withinGate(content)).toBe(true);
    expect(content).not.toContain("SYN-55123");
    expect(decision).toMatchObject({
      classification: "uncertain",
      stage: "rule",
    });
    expect(view?.incompleteReasons).toEqual(["purchase_cue_clipped"]);

    const whole = await route(message(`Weekly deals ${prices}`));
    expect(whole.decision).toMatchObject({
      classification: "unrelated",
      stage: "decision",
    });
  });

  // The preheader is bounded separately from the body; with cues overflowing,
  // a receipt clipped from the preheader went unchecked.
  it("keeps a message uncertain when overflowing cues meet a clipped preheader", async () => {
    const prices = Array.from(
      { length: 210 },
      (_, cents) =>
        `$${10 + Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`,
    ).join(" ");
    const { decision, view, content } = await route(
      message(
        `<html><body><div style="display:none">${"filler ".repeat(100)}Receipt for order #SYN-55123</div>` +
          `<p>Weekly deals ${prices}</p></body></html>`,
        "text/html",
      ),
    );
    expect(content).not.toContain("SYN-55123");
    expect(JSON.parse(content)).toMatchObject({ bodyComplete: true });
    expect(decision).toMatchObject({
      classification: "uncertain",
      stage: "rule",
    });
    expect(view?.incompleteReasons).toEqual(["purchase_cue_clipped"]);
  });

  // A whole line used to be dropped for one footer phrase, so a receipt
  // sentence ending in "© Shop" counted as nothing beside a content image.
  it("counts a receipt line that ends in a footer phrase as readable", async () => {
    const raw: GmailMessage = {
      id: "synthetic-mixed-footer",
      payload: {
        mimeType: "multipart/alternative",
        headers: [{ name: "Subject", value: "Your order" }],
        parts: [
          part(
            "Thanks for your order of two bamboo spatula sets; it ships from our warehouse tomorrow morning. © Synthetic Shop",
          ),
          part(EMAIL_HTML_FIXTURES.imageOnlyReceipt, "text/html"),
        ],
      },
    };
    const { view } = await route(raw);
    expect(view?.incompleteReasons).not.toContain("image_only");
  });

  // The plain-text alternative's footer used to count as readable text, so an
  // image-only receipt with an unsubscribe footer looked complete.
  it("keeps an image-only receipt uncertain beside a footer-only text part", async () => {
    const raw: GmailMessage = {
      id: "synthetic-multipart",
      payload: {
        mimeType: "multipart/alternative",
        headers: [{ name: "Subject", value: "Your receipt" }],
        parts: [
          part(
            "You are receiving this email because you shopped with Synthetic Shop.\n" +
              "Unsubscribe or manage your preferences: https://example.test/prefs\n" +
              "Privacy policy · © 2026 Synthetic Shop",
          ),
          part(EMAIL_HTML_FIXTURES.imageOnlyReceipt, "text/html"),
        ],
      },
    };
    const { decision, view } = await route(raw);
    expect(decision).toMatchObject({
      classification: "uncertain",
      stage: "rule",
    });
    expect(view?.incompleteReasons).toContain("image_only");
  });

  it("lets unrelated stand when the clipped middle carries no purchase cue", async () => {
    const { decision, content } = await route(
      message("Club news " + "filler ".repeat(8_000) + " See you soon"),
    );
    expect(JSON.parse(content)).toMatchObject({
      bodyComplete: false,
      omittedPurchaseCues: false,
    });
    expect(decision).toMatchObject({
      classification: "unrelated",
      stage: "decision",
    });
  });

  it("keeps a message with attachments uncertain", async () => {
    const raw = message();
    raw.payload = {
      ...raw.payload,
      mimeType: "multipart/mixed",
      parts: [
        part("Please see attached."),
        {
          mimeType: "application/pdf",
          filename: "statement.pdf",
          body: { attachmentId: "synthetic-attachment", size: 900 },
        },
      ],
    };
    const { decision, view } = await route(raw);
    expect(decision).toMatchObject({
      classification: "uncertain",
      stage: "rule",
    });
    expect(view?.incompleteReasons).toEqual(["attachments"]);
  });

  it("keeps forwarded multipart mail with dropped text parts uncertain", async () => {
    const raw = message();
    raw.payload = {
      ...raw.payload,
      mimeType: "multipart/mixed",
      parts: [
        part("FYI, forwarding this."),
        part(EMAIL_HTML_FIXTURES.forwarded, "text/html"),
        part("Second inline note without its own HTML."),
      ],
    };
    const { decision, view } = await route(raw);
    expect(decision).toMatchObject({
      classification: "uncertain",
      stage: "rule",
    });
    expect(view?.incompleteReasons).toEqual(["mime_parts_dropped"]);
  });

  it("keeps a clipped cue-bearing link uncertain but ignores clipped plain links", async () => {
    const plainLinks = Array.from(
      { length: 20 },
      (_, index) =>
        `<a href="https://news.example.test/article/${index}">Story ${index}</a>`,
    ).join("");
    const unrelated = await route(
      message(
        `<html><body><p>Weekly stories</p>${plainLinks}</body></html>`,
        "text/html",
      ),
    );
    expect(unrelated.decision.classification).toBe("unrelated");

    const orderLinks = Array.from(
      { length: 14 },
      (_, index) =>
        `<a href="https://shop.example.test/orders/${index}">Order ${index}</a>`,
    ).join("");
    const clipped = await route(
      message(
        `<html><body><p>Account update</p>${orderLinks}</body></html>`,
        "text/html",
      ),
    );
    expect(clipped.decision.classification).toBe("uncertain");
    expect(clipped.view?.incompleteReasons).toEqual(["links_clipped"]);
  });

  it("escalates missing bodies without classifying a provider snippet", async () => {
    const choose = vi.fn(async () => "unrelated" as const);
    const raw = { ...message(), snippet: "Your order shipped" };
    const routed = await routeGmailMessage(
      raw,
      normalizeMessage("google-subject", raw),
      choose,
    );
    expect(routed).toMatchObject({
      decision: { classification: "uncertain", stage: "rule" },
      view: null,
    });
    expect(choose).not.toHaveBeenCalled();
  });

  it("escalates MIME data that is shorter than the provider's declared bytes", async () => {
    const raw = message("receipt");
    if (raw.payload?.body) raw.payload.body.size = 900;
    const choose = vi.fn(async () => "unrelated" as const);
    expect(
      (
        await routeGmailMessage(
          raw,
          normalizeMessage("google-subject", raw),
          choose,
        )
      ).decision,
    ).toMatchObject({ classification: "uncertain", stage: "rule" });
    expect(choose).not.toHaveBeenCalled();
  });

  it.each([
    [
      "quotes and backslashes",
      'Receipt "quoted" \\ path\\to\\file\n'.repeat(4_000),
    ],
    ["Unicode", "Receipt 🧾 für Café — 領収書 ".repeat(4_000)],
  ])(
    "fills the real request gate with %s without broken characters",
    async (_name, body) => {
      const { content } = await route(message(body), "uncertain");
      expect(withinGate(content)).toBe(true);
      expect(Buffer.byteLength(content)).toBeGreaterThan(20_000);
      expect(content).not.toContain("�");
      expect(JSON.parse(content).bodyComplete).toBe(false);
    },
  );

  it("bounds metadata-heavy mail from sender, subject and body evidence", async () => {
    const raw = message(
      "Your order shipped. " + "x".repeat(40_000) + " Tracking: synthetic",
    );
    raw.payload = {
      ...raw.payload,
      headers: [
        { name: "From", value: "Forge Orders <orders@shop.example>" },
        { name: "Subject", value: "Your order is on its way" },
        { name: "DKIM-Signature", value: "transport-data".repeat(8_000) },
      ],
    };
    const { decision, content } = await route(raw, "related");
    expect(decision).toMatchObject({
      classification: "related",
      stage: "decision",
    });
    expect(withinGate(content)).toBe(true);
    expect(JSON.parse(content)).toMatchObject({
      senderDomain: "shop.example",
      headers: {
        from: "Forge Orders <orders@shop.example>",
        subject: "Your order is on its way",
      },
      bodyComplete: false,
    });
    expect(content).toContain("Your order shipped");
    expect(content).toContain("Tracking: synthetic");
    expect(content).not.toContain("transport-data");
  });

  it("keeps HTML evidence bounded and Unicode-safe", async () => {
    const { content, decision } = await route(
      message(
        `<html><body>Newsletter${Array.from(
          { length: 30 },
          () =>
            `<a href="https://shop.example/${"x".repeat(2_000)}">${"offer".repeat(500)}</a><img src="https://shop.example/image" alt="${"🧾".repeat(1_000)}"><script type="application/ld+json">${JSON.stringify({ "@type": "Order", description: "receipt".repeat(2_000) })}</script>`,
        ).join("")}</body></html>`,
        "text/html",
      ),
    );
    expect(withinGate(content)).toBe(true);
    expect(content).not.toContain("�");
    expect(JSON.parse(content).htmlEvidenceComplete).toBe(false);
    expect(decision).toMatchObject({
      classification: "uncertain",
      stage: "rule",
    });
  });
});
