import type { EntityRef } from "@cubby/schemas/entity";
import { createLogger } from "@cubby/worker-tracing";

import { scrubErrorMessage } from "~/lib/error-diagnostics";
import type { Database } from "~/server/db";
import { retrieveEmailConnectionCandidates } from "~/server/domains/connection/repo/email-connections";
import {
  EMAIL_PURCHASE_PAGE,
  emailPurchaseDiscoveryDue,
  emailPurchaseDiscoveryNext,
  emailPurchaseDiscoveryPage,
  emailsWithSuggestedPurchases,
} from "~/server/domains/connection/repo/email-purchase-cursor";
import {
  prepareEntityConnectionEvidence,
  publishPreparedEntityConnections,
} from "~/server/domains/connection/repo/entity-connections";
import type { BackgroundDrain } from "~/server/generic/background/drains";

const log = createLogger("email-purchase-discovery");
const PASS_INTERVAL_MS = 60 * 60_000;

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

/** The routine pass over Emails whose retained evidence suggests a purchase link. */
export const emailPurchaseDiscoveryDrain: BackgroundDrain = {
  name: "email-purchase-discovery",
  label: (unit) =>
    unit === "email-purchase-discovery" ? "Email purchase links" : undefined,
  due: () => emailPurchaseDiscoveryDue("email-purchase-discovery"),
  next: emailPurchaseDiscoveryNext,
  page: (db) =>
    emailPurchaseDiscoveryPage(db, async (tx, cursor) => {
      if (cursor.nextAt && Date.parse(cursor.nextAt) > Date.now())
        return {
          result: { claimed: 0, nextAt: new Date(cursor.nextAt) },
          next: cursor.after,
        };
      const emails = await emailsWithSuggestedPurchases(tx, cursor.after);
      for (const email of emails)
        try {
          await discoverEmailPurchaseConnections(tx, {
            entityKind: "email",
            entityId: email.shortcode,
          });
        } catch (error) {
          // One changed Email must not wedge the pass; the next pass retries it.
          log.warn("Email purchase discovery skipped an Email", {
            error: scrubErrorMessage(String(error)),
          });
        }
      const next =
        emails.length === EMAIL_PURCHASE_PAGE ? emails.at(-1)!.id : null;
      return {
        // The page ran even when it found nothing: its successor waits an hour.
        result: {
          claimed: Math.max(1, emails.length),
          nextAt: next ? null : new Date(Date.now() + PASS_INTERVAL_MS),
        },
        next,
      };
    }),
};
