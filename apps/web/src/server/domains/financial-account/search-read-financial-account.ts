import type {
  FinancialAccountCardNumber,
  FinancialAccountIdentity,
} from "@cubby/schemas/financial-account";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { sql, and, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { Database, DrizzleTransaction } from "~/server/db";
import { unwrapDb, notDeleted } from "~/server/db/helpers";
import { financialAccount as searchTablefinancialAccount } from "~/server/db/schema";
import { financialAccount } from "~/server/db/schema";
import { withOptionalLimit } from "~/server/generic/embedding/repo/embedding-load-options";
import { buildFinancialAccountEmbeddingText } from "~/server/generic/embedding/repo/semantic/text";
import type {
  EmbeddingLoadOptions,
  SearchableEntityText,
  SearchReadPort,
} from "~/server/generic/search/repo/search-read-port";

const presentIdentityTerms = (terms: Array<string | null>): string[] =>
  terms.filter((term): term is string => term !== null && term.length > 0);
const identityTerms = (
  identity: FinancialAccountIdentity,
  cardNumbers: FinancialAccountCardNumber[],
): string[] => {
  const last4s = cardNumbers.map((card) => card.last4);
  switch (identity.kind) {
    case "credit_card":
      return presentIdentityTerms([identity.kind, identity.network, ...last4s]);
    case "bank_account":
      return presentIdentityTerms([
        identity.kind,
        identity.accountType,
        ...last4s,
      ]);
    case "stored_value":
      return presentIdentityTerms([identity.kind, ...last4s]);
    case "cash":
      return [identity.kind];
    case "other":
      return presentIdentityTerms([identity.kind, ...last4s]);
  }
};

async function loadEmbeddingText(
  db: Database | DrizzleTransaction,
  options: EmbeddingLoadOptions = {},
): Promise<SearchableEntityText[]> {
  const queryConfig = withOptionalLimit(
    {
      where: and(
        notDeleted(financialAccount),
        options.ids?.length
          ? inArray(
              financialAccount.id,
              options.ids.map((id) => parseEntityId("financialAccount", id)),
            )
          : undefined,
      ),
      with: { providerVendor: { columns: { name: true } } },
      columns: {
        id: true,
        name: true,
        identity: true,
        sourceAliases: true,
        cardNumbers: true,
        notes: true,
      },
    },
    options.limit,
  );
  const rows = await unwrapDb(db).query.financialAccount.findMany(queryConfig);
  return rows.map((row) => ({
    entityKind: "financialAccount",
    entityId: row.id,
    embeddingText: buildFinancialAccountEmbeddingText({
      name: row.name,
      identityTerms: [
        ...identityTerms(row.identity, row.cardNumbers),
        ...(row.providerVendor ? [row.providerVendor.name] : []),
      ],
      sourceAliasTerms: row.sourceAliases.flatMap((alias) => [
        alias.source,
        alias.alias,
        alias.externalAccountId,
      ]),
      notes: row.notes,
    }),
  }));
}
export const financialAccountSearch = {
  document: ({ types, requested, bounded }) => sql`
      SELECT ${"financialAccount"}::text, fa."id"::text, fa."shortcode", fa."name", fa."identity"->>${"kind"}, fa."identity"->>${"kind"}, ARRAY[]::text[],
        ARRAY(
          SELECT term
          FROM jsonb_array_elements(fa."sourceAliases") alias,
            LATERAL unnest(ARRAY[alias->>${"source"}, alias->>${"alias"}, alias->>'externalAccountId']) term
          WHERE term IS NOT NULL AND term <> ''
        ) || ARRAY(
          SELECT card->>'last4' FROM jsonb_array_elements(fa."cardNumbers") card
        )
      FROM "FinancialAccount" fa WHERE ${notDeleted(alias(searchTablefinancialAccount, "fa"))} AND ${"financialAccount"}::text IN (${types}) AND ${requested(sql`fa."id"`)} AND ${bounded(sql`fa."createdAt"`)}`,
  embedding: loadEmbeddingText,
} satisfies SearchReadPort;
