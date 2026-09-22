import { ledgerPartyShortcode } from "@cubby/schemas/identifiers";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { z } from "zod";

import { CollectionProductsTable } from "~/app/collections/collection-detail-page";
import { collection } from "~/app/collections/collection.functions";
import { ErrorDisplay } from "~/components/feedback/error-display";
import { Stack } from "~/components/layout";
import { Page } from "~/components/page/Page";
import { entityDetailFor } from "~/entities/entity-detail.functions";
import { urlStringParam } from "~/lib/search-params";

export const Route = createFileRoute(
  "/_authenticated/collections/wardrobe/$owner",
)({
  beforeLoad: ({ params }) => {
    ledgerPartyShortcode.parse(params.owner);
  },
  validateSearch: z.object({
    q: urlStringParam,
    page: z.coerce.number().int().positive().optional(),
  }),
  component: WardrobePage,
});

function WardrobePage() {
  const ownerId = ledgerPartyShortcode.parse(Route.useParams().owner);
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const page = search.page ?? 1;
  const result = useQuery(
    collection.referenceDetail.queryOptions({
      reference: { kind: "wardrobe", ownerId },
      search: search.q,
      pagination: { pageIndex: page - 1, pageSize: 50 },
    }),
  );
  const owner = useQuery(entityDetailFor("ledgerParty").queryOptions(ownerId));
  return (
    <Page title="Wardrobe" layout="contained" mobileTitleVisible>
      <Stack gap="lg">
        <div>
          <Link
            to="/ledger-parties/$shortcode"
            params={{ shortcode: ownerId }}
            className="text-sm font-medium underline decoration-border/70 decoration-dotted underline-offset-2 transition-colors hover:text-primary hover:decoration-primary hover:decoration-solid"
          >
            {owner.data?.name ?? ownerId}
          </Link>
          <p className="text-sm text-muted-foreground">
            Clothing, shoes, and wearable bags currently assigned to this
            person. Locations and quantities include only their inventory.
          </p>
        </div>
        {result.isPending ? (
          <p>Loading wardrobe…</p>
        ) : result.isError ? (
          <ErrorDisplay
            error={result.error}
            title="the wardrobe"
            onRetry={() => void result.refetch()}
          />
        ) : (
          <CollectionProductsTable
            products={result.data.products}
            totalCount={result.data.totalCount}
            search={search.q}
            page={page}
            onSearchChange={(next) =>
              navigate({
                search: (previous) => ({ ...previous, ...next }),
                replace: true,
              })
            }
          />
        )}
      </Stack>
    </Page>
  );
}
