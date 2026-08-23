import type { FundingPartyRef } from "@cubby/schemas/household-contribution";
import type { FundingSourceId } from "@cubby/schemas/identifiers";
import { and, eq } from "drizzle-orm";
import type { Database, DrizzleTransaction } from "~/server/db";
import { fundingSource, person } from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import { notDeleted, unwrapDb } from "~/server/repo/database-helpers";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";

export type ResolvedFundingParty = {
  sourceId: FundingSourceId;
  party: {
    key: string;
    kind: "person" | "shared_fund";
    name: string;
    household: boolean;
  };
};

export async function resolveFundingPartyOrThrow(
  db: Database | DrizzleTransaction,
  partyRef: FundingPartyRef,
): Promise<ResolvedFundingParty> {
  const client = unwrapDb(db);
  if (partyRef.kind === "person") {
    const personId = await resolveOrThrow(db, "person", partyRef.id);
    const [row] = await client
      .select({
        sourceId: fundingSource.id,
        shortcode: person.shortcode,
        name: person.name,
        personKind: person.kind,
      })
      .from(fundingSource)
      .innerJoin(person, eq(fundingSource.personId, person.id))
      .where(
        and(
          eq(fundingSource.personId, personId),
          notDeleted(fundingSource),
          notDeleted(person),
        ),
      )
      .limit(1);
    if (!row) {
      throw createAppError(
        "HOUSEHOLD_LEDGER_INVALID_ATTRIBUTION",
        `Person ${partyRef.id} is missing a live funding source`,
      );
    }
    return {
      sourceId: row.sourceId,
      party: {
        key: row.shortcode,
        kind: "person",
        name: row.name,
        household: row.personKind === "household",
      },
    };
  }

  const [row] = await client
    .select({
      sourceId: fundingSource.id,
      key: fundingSource.fundKey,
      name: fundingSource.name,
    })
    .from(fundingSource)
    .where(
      and(
        eq(fundingSource.kind, "shared_fund"),
        eq(fundingSource.fundKey, partyRef.key),
        notDeleted(fundingSource),
      ),
    )
    .limit(1);
  if (!row?.key || !row.name) {
    throw createAppError(
      "HOUSEHOLD_LEDGER_INVALID_ATTRIBUTION",
      `Funding fund not found: ${partyRef.key}`,
    );
  }
  return {
    sourceId: row.sourceId,
    party: {
      key: row.key,
      kind: "shared_fund",
      name: row.name,
      household: true,
    },
  };
}
