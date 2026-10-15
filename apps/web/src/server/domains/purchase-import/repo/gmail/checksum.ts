import { sha256Hex } from "@cubby/shared/sha256";

import type { GmailNormalizedMessage } from "./types";

/** Canonical provider original identity; preserve this projection across retained and transient reads. */
export const originalChecksum = (normalized: GmailNormalizedMessage) =>
  sha256Hex(
    JSON.stringify({
      headers: normalized.mail.headers,
      bodyText: normalized.mail.bodyText,
      bodyHtml: normalized.mail.bodyHtml,
      attachments: normalized.attachments.map(
        ({ sourceKey, filename, mimeType, size }) => ({
          sourceKey,
          filename,
          mimeType,
          size,
        }),
      ),
    }),
  );
