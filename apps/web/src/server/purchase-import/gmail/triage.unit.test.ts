/** Failures: snippets classify missing bodies negatively; MIME truncation loses evidence;
 * large inputs get silently sliced; uncertain routing becomes a negative label. */
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
  it("escalates missing bodies and oversized content without calling or truncating Jev", async () => {
    const choose = vi.fn(async () => "unrelated" as const);
    for (const raw of [message(), message("x".repeat(40_000))]) {
      expect(
        await routeGmailMessage(
          raw,
          normalizeMessage("google-subject", raw),
          choose,
        ),
      ).toBe("uncertain");
    }
    expect(choose).not.toHaveBeenCalled();
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
    ).toBe("uncertain");
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
    ).toBe("related");
    expect(choose.mock.calls[0]?.[0]).toContain("Forge Services");
  });
});
