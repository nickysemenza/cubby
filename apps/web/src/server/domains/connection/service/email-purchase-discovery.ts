import type { EntityRef } from "@cubby/schemas/entity";
import { createLogger } from "@cubby/worker-tracing";
import { z } from "zod";

import { scrubErrorMessage } from "~/lib/error-diagnostics";
import type { Database } from "~/server/db";
import { retrieveEmailConnectionCandidates } from "~/server/domains/connection/repo/email-connections";
import {
  EMAIL_PURCHASE_PAGE,
  emailsWithSuggestedPurchases,
} from "~/server/domains/connection/repo/email-purchase-cursor";
import {
  prepareEntityConnectionEvidence,
  publishPreparedEntityConnections,
} from "~/server/domains/connection/repo/entity-connections";
import { definePass } from "~/server/kernel/api";

const log = createLogger("email-purchase-discovery");

/** The next UTC hour, so a finished pass lands with cron and the derived pass. */
function nextUtcHour(now = Date.now()) {
  const next = new Date(now);
  next.setUTCMinutes(0, 0, 0);
  next.setUTCHours(next.getUTCHours() + 1);
  return next;
}

/**
 * Publishes the Suggestions that propose a retained Email's purchase link.
 * Retrieval is deterministic SQL over the Email purchase evidence policy; no
 * model runs and no Run is created.
 */
export async function discoverEmailPurchaseConnections(
  db: Database,
  source: EntityRef,
) {
  const candidates = await retrieveEmailConnectionCandidates(db, source);
  if (!candidates.length) return;
  await publishPreparedEntityConnections(
    db,
    await prepareEntityConnectionEvidence(db, candidates),
  );
}

/** One resumable deterministic census over retained Email evidence. */
export const emailPurchaseDiscoveryPass = definePass({
  name: "email.purchase-discovery",
  async run(db, raw) {
    const cursor = z
      .object({ after: z.uuid().nullable().default(null) })
      .parse(raw ?? {});
    const emails = await emailsWithSuggestedPurchases(db, cursor.after);
    const next =
      emails.length === EMAIL_PURCHASE_PAGE ? emails.at(-1)!.id : null;
    return {
      cursor: { after: next },
      done: false,
      availableAt: next ? new Date() : nextUtcHour(),
      async publish(tx) {
        for (const email of emails)
          try {
            await discoverEmailPurchaseConnections(tx, {
              entityKind: "email",
              entityId: email.shortcode,
            });
          } catch (error) {
            log.warn("Email purchase discovery skipped an Email", {
              error: scrubErrorMessage(String(error)),
            });
          }
      },
    };
  },
});
