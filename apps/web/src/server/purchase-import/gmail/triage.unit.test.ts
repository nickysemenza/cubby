/** Failures: missing originals classify negatively; omitted body evidence is discarded;
 * transport headers or HTML styling consume the entire decision context. */
import { describe, expect, it, vi } from "vitest";

import { normalizeMessage } from "./normalize";
import { routeGmailMessage } from "./triage";
import type { GmailMessage } from "./types";

const message = (body?: string): GmailMessage => ({
  id: "synthetic-mail",
  payload: {
    mimeType: "text/plain",
    body: body
      ? {
          data: Buffer.from(body).toString("base64url"),
          size: Buffer.byteLength(body),
        }
      : {},
    headers: [{ name: "Subject", value: "Payment" }],
  },
});
describe("transient Gmail triage", () => {
  it("escalates missing bodies without classifying a provider snippet", async () => {
    const choose = vi.fn(async () => "unrelated" as const);
    const raw = { ...message(), snippet: "Your order shipped" };
    expect(
      await routeGmailMessage(
        raw,
        normalizeMessage("google-subject", raw),
        choose,
      ),
    ).toMatchObject({ classification: "uncertain", stage: "rule" });
    expect(choose).not.toHaveBeenCalled();
  });
  it("classifies an oversized original from bounded sender, subject and body evidence", async () => {
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
    let content = "";
    const result = await routeGmailMessage(
      raw,
      normalizeMessage("google-subject", raw),
      async (input) => {
        content = input;
        return "related";
      },
    );
    expect(result).toMatchObject({ classification: "related", stage: "jev" });
    expect(Buffer.byteLength(content)).toBeLessThanOrEqual(12_000);
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
  it("cannot discard an oversized original from an unrelated partial verdict", async () => {
    const raw = message(
      "Newsletter " + "x".repeat(40_000) + " Receipt for your purchase",
    );
    const choose = vi.fn(async () => "unrelated" as const);
    expect(
      await routeGmailMessage(
        raw,
        normalizeMessage("google-subject", raw),
        choose,
      ),
    ).toMatchObject({ classification: "uncertain", stage: "rule" });
    expect(choose).toHaveBeenCalledOnce();
  });
  it.each([
    '<script type="application/ld+json">{"@type":"Order","orderNumber":"synthetic-order"}</script>',
    '<a href="https://shop.example/orders/synthetic-order">View details</a>',
    '<div itemscope itemtype="http://schema.org/Order"><meta itemprop="orderNumber" content="synthetic-order"></div>',
  ])(
    "preserves HTML evidence omitted from readable text: %s",
    async (evidence) => {
      const raw = message(
        `<html><body>Account update${evidence}</body></html>`,
      );
      raw.payload = { ...raw.payload, mimeType: "text/html" };
      const choose = vi.fn(async () => "unrelated" as const);
      expect(
        await routeGmailMessage(
          raw,
          normalizeMessage("google-subject", raw),
          choose,
        ),
      ).toMatchObject({ classification: "uncertain", stage: "rule" });
      expect(choose).toHaveBeenCalledOnce();
    },
  );
  it("bounds serialized Unicode and escaped body bytes without broken characters", async () => {
    const raw = message('Receipt 🧾 "\\\n'.repeat(5_000));
    let content = "";
    expect(
      await routeGmailMessage(
        raw,
        normalizeMessage("google-subject", raw),
        async (input) => {
          content = input;
          return "uncertain";
        },
      ),
    ).toMatchObject({ classification: "uncertain", stage: "jev" });
    expect(Buffer.byteLength(content)).toBeLessThanOrEqual(12_000);
    expect(content).not.toContain("�");
    expect(JSON.parse(content).bodyComplete).toBe(false);
  });
  it("uses readable HTML instead of spending context on styles", async () => {
    const raw = message(
      "<html><head><style>" +
        ".layout { color: red; }".repeat(8_000) +
        "</style></head><body><p>Your subscription renewed at Forge Services.</p></body></html>",
    );
    raw.payload = { ...raw.payload, mimeType: "text/html" };
    let content = "";
    expect(
      await routeGmailMessage(
        raw,
        normalizeMessage("google-subject", raw),
        async (input) => {
          content = input;
          return "related";
        },
      ),
    ).toMatchObject({ classification: "related", stage: "jev" });
    expect(content).toContain("Your subscription renewed");
    expect(content).not.toContain("color: red");
    expect(Buffer.byteLength(content)).toBeLessThanOrEqual(12_000);
  });
  it("escalates MIME data that is shorter than the provider's declared bytes", async () => {
    const raw = message("receipt");
    if (raw.payload?.body) raw.payload.body.size = 900;
    const choose = vi.fn(async () => "unrelated" as const);
    expect(
      await routeGmailMessage(
        raw,
        normalizeMessage("google-subject", raw),
        choose,
      ),
    ).toMatchObject({ classification: "uncertain", stage: "rule" });
    expect(choose).not.toHaveBeenCalled();
  });
  it("routes readable original content including unfamiliar shared senders", async () => {
    const raw = message("Your subscription renewed. Merchant: Forge Services.");
    const choose = vi.fn(async (_content: string) => "related" as const);
    expect(
      await routeGmailMessage(
        raw,
        normalizeMessage("google-subject", raw),
        choose,
      ),
    ).toMatchObject({ classification: "related", stage: "jev" });
    expect(choose.mock.calls[0]?.[0]).toContain("Forge Services");
  });
});
