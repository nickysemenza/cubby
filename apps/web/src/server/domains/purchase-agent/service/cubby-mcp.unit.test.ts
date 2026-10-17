/** Failure: the cap measurement skips an original attachment's descriptor
 * while the adapter re-emits it as text, so a long filename pushes the
 * agent's text past the cap and Pi cuts the read. */
import { MAIL_READ_RESPONSE_MAX_BYTES } from "@cubby/schemas/mailbox-research";
import { describe, expect, it } from "vitest";

import {
  fitMailRead,
  mailReadContent,
} from "~/server/domains/purchase-import/repo/gmail/read-content";

import { cubbyToolResult } from "./cubby-mcp";

describe("cubbyToolResult Email reads", () => {
  it("keeps an attachment read's agent text under the cap", () => {
    const content = mailReadContent(
      {
        snippet: null,
        bodyText: "Synthetic line item $1.00\n".repeat(6_000),
        bodyHtml: null,
      },
      {},
    );
    const read = fitMailRead({
      content,
      attachments: Array.from({ length: 70 }, (_, index) => ({
        attachmentId: `synthetic-attachment-${index}`,
        filename: `synthetic-receipt-${index}-${"y".repeat(1_000)}.pdf`,
        mimeType: "application/pdf",
        checksum: "c".repeat(64),
      })),
      originalAttachment: {
        attachmentId: "a".repeat(200),
        filename: `${"f".repeat(996)}.pdf`,
        mimeType: "application/pdf",
        checksum: "d".repeat(64),
        dataBase64: "QUJD".repeat(100_000),
      },
    });
    const result = cubbyToolResult({
      content: [{ type: "text", text: JSON.stringify(read) }],
      structuredContent: read,
    });
    const [text] = result.output ?? [];
    expect(text?.type).toBe("text");
    const bytes = new TextEncoder().encode(
      text?.type === "text" ? text.text : "",
    ).length;
    expect(bytes).toBeGreaterThan(MAIL_READ_RESPONSE_MAX_BYTES - 10_000);
    expect(bytes).toBeLessThanOrEqual(MAIL_READ_RESPONSE_MAX_BYTES);
  });
});
