import { emailPurchaseFact } from "@cubby/schemas/email-relationship-facts";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { and, inArray } from "drizzle-orm";

import { notDeleted, unwrapDb } from "~/server/db/helpers";
import { email } from "~/server/db/schema";
import {
  readEmailPurchaseEvidence,
  loadRelationshipPurchaseGates,
  foldScopedEmailPurchaseFacts,
  strongestLinkState,
} from "~/server/domains/email/repo/email-purchase-links";
import type {
  DerivedCompute,
  DerivedComputed,
} from "~/server/generic/derived/repo/compute";

const emailRelationshipCompute: DerivedCompute = async (db, ids) => {
  const rows = await unwrapDb(db)
    .select({ id: email.id, ledgerPartyId: email.ledgerPartyId })
    .from(email)
    .where(
      and(
        inArray(
          email.id,
          ids.map((id) => parseEntityId("email", id)),
        ),
        notDeleted(email),
      ),
    );
  const evidence = await readEmailPurchaseEvidence(
    db,
    rows.map(({ id }) => parseEntityId("email", id)),
    null,
    "ignore",
  );
  const purchases = await loadRelationshipPurchaseGates(db, [
    ...new Set(evidence.map((row) => row.purchaseId)),
  ]);
  const byEmail = new Map<string, typeof evidence>();
  for (const fact of evidence) {
    const group = byEmail.get(fact.emailId) ?? [];
    group.push(fact);
    byEmail.set(fact.emailId, group);
  }
  const results = rows.map((row) => {
    const facts = (byEmail.get(row.id) ?? []).map((fact) =>
      emailPurchaseFact.parse(fact),
    );
    const links = foldScopedEmailPurchaseFacts({
      facts,
      emailId: row.id,
      ownerId: row.ledgerPartyId,
      purchases,
      scope: null,
    });
    return { id: row.id, facts, links };
  });
  return new Map(
    results.map(({ id, facts, links }) => [
      id,
      {
        value: {
          facts,
          evidence: facts.map((fact) => ({
            purchaseId: fact.purchaseShortcode,
            kind: fact.kind,
            changed: fact.changed,
            proposedBy: fact.proposedBy,
          })),
          purchaseLinks: links,
          linkState: strongestLinkState(links),
          linked: links.some((link) => link.state === "linked"),
        },
        sort: null,
      } satisfies DerivedComputed,
    ]),
  );
};
export const emailDerivedComputes = {
  "email.relationshipFacts": emailRelationshipCompute,
};
