import type { ReportBlock } from "@cubby/schemas/entity-report";
import {
  currentScopedPosition,
  MAIL_SEARCH_STATE_LABEL,
  scopedPositionState,
} from "@cubby/schemas/mailbox-research";
import { eq } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { vendor } from "~/server/db/schema";
import { loadGmailCursor } from "~/server/domains/purchase-import/repo/gmail/persistence";
import { listMemberMailboxes } from "~/server/domains/purchase-import/repo/gmail/targets";
import { vendorSearchTerms } from "~/server/domains/purchase-import/repo/gmail/vendor-identity";
import { vendorMailQueries } from "~/server/domains/purchase-import/repo/gmail/vendor-mail-scope";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";

const finishedAt = (iso: string | undefined) =>
  iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : "—";

/**
 * Each current Mail search of a Vendor in each member mailbox, with the
 * finish time and Email count recorded since those were tracked.
 */
export async function vendorMailSearchReport(
  db: Database,
  code: string,
): Promise<ReportBlock[]> {
  const vendorId = await resolveOrThrow(db, "vendor", code);
  const [[row], mailboxes] = await Promise.all([
    getDb(db)
      .select({
        website: vendor.website,
        orderEmailSenders: vendor.orderEmailSenders,
      })
      .from(vendor)
      .where(eq(vendor.id, vendorId))
      .limit(1),
    listMemberMailboxes(db),
  ]);
  const queries = row
    ? vendorMailQueries(vendorId, vendorSearchTerms(row))
    : [];
  if (queries.length === 0)
    return [
      {
        kind: "note",
        text: "No Mail searches: add a verified order Email sender or a website.",
      },
    ];
  const cursors = await Promise.all(
    mailboxes.map(async (mailbox) => ({
      mailbox,
      coverage: (
        await loadGmailCursor(db, {
          ledgerPartyId: mailbox.ledgerPartyId,
          mailboxId: mailbox.mailboxId,
        })
      ).coverage,
    })),
  );
  return [
    {
      kind: "table",
      columns: ["Search", "Mailbox", "Status", "Finished", "Emails"],
      rows: cursors.flatMap(({ mailbox, coverage }) =>
        queries.map((query) => {
          const position = currentScopedPosition(coverage, query);
          return {
            id: `${mailbox.ledgerPartyId}:${mailbox.mailboxId}:${query.key}`,
            cells: [
              query.query,
              `${mailbox.name} · ${mailbox.mailboxId}`,
              MAIL_SEARCH_STATE_LABEL[scopedPositionState(position)],
              finishedAt(position?.completedAt),
              position?.emailCount === undefined
                ? "—"
                : String(position.emailCount),
            ],
          };
        }),
      ),
      empty: "No member has connected a Google mailbox.",
    },
  ];
}
