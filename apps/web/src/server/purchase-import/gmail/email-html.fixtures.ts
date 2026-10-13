import type { WCompactEmail } from "@cubby/recipebridge";

import forwarded from "../../../../../../recipebridge/fixtures/email/forwarded.html?raw";
import imageOnlyReceipt from "../../../../../../recipebridge/fixtures/email/image-only-receipt.html?raw";
import jsonLdOrder from "../../../../../../recipebridge/fixtures/email/json-ld-order.html?raw";
import newsletter from "../../../../../../recipebridge/fixtures/email/newsletter.html?raw";
import orderTable from "../../../../../../recipebridge/fixtures/email/order-table.html?raw";

/** The synthetic Email HTML recipebridge's own tests read. */
export const EMAIL_HTML_FIXTURES = {
  forwarded,
  imageOnlyReceipt,
  jsonLdOrder,
  newsletter,
  orderTable,
};

/**
 * What `compact_email_html` returns for each fixture, reduced to values that
 * change with any divergence: Node and workerd must both produce exactly this.
 */
export const EMAIL_FIXTURE_SUMMARY = {
  forwarded: {
    bytes: 863,
    cues: ["$41.10", "$78.90", "$120.00", "INV-20931", "invoice", "amount due"],
    readableChars: 289,
    truncated: false,
  },
  imageOnlyReceipt: {
    bytes: 691,
    cues: [] as string[],
    readableChars: 0,
    truncated: false,
  },
  jsonLdOrder: {
    bytes: 789,
    cues: [] as string[],
    readableChars: 43,
    truncated: false,
  },
  newsletter: {
    bytes: 1559,
    cues: [] as string[],
    readableChars: 301,
    truncated: false,
  },
  orderTable: {
    bytes: 1600,
    cues: [
      "$24.00",
      "$18.50",
      "$7.25",
      "$49.75",
      "$54.20",
      "SYN-40217",
      "order total",
      "subtotal",
    ],
    readableChars: 202,
    truncated: false,
  },
};

export const summarizeEmailFixtures = (
  compact: (html: string) => WCompactEmail,
) =>
  Object.fromEntries(
    Object.entries(EMAIL_HTML_FIXTURES).map(([name, html]) => {
      const email = compact(html);
      return [
        name,
        {
          bytes: new TextEncoder().encode(JSON.stringify(email)).byteLength,
          cues: email.cues,
          readableChars: email.readable_chars,
          truncated: email.truncated,
        },
      ];
    }),
  );
