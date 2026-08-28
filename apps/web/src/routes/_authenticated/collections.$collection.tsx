import { collectionSlug } from "@cubby/schemas/collection";
import { formatCollectionLabel } from "@cubby/shared/collection-tag";
import {
  createFileRoute,
  stripSearchParams,
  useNavigate,
} from "@tanstack/react-router";
import { z } from "zod";

import { CollectionDetailPage } from "~/app/collections/collection-detail-page";
import { Page } from "~/components/page/Page";
import { pageTitle } from "~/lib/page-title";
import { urlStringParam } from "~/lib/search-params";

const searchSchema = z.object({
  q: urlStringParam,
  page: z.coerce.number().int().positive().optional().catch(undefined),
});

export const Route = createFileRoute("/_authenticated/collections/$collection")(
  {
    validateSearch: searchSchema,
    search: { middlewares: [stripSearchParams({ page: 1 })] },
    component: CollectionRoute,
    head: ({ params }) => ({
      meta: [{ title: pageTitle(formatCollectionLabel(params.collection)) }],
    }),
  },
);

function CollectionRoute() {
  const params = Route.useParams();
  const collection = collectionSlug.parse(params.collection);
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  return (
    <Page
      title={formatCollectionLabel(collection)}
      eyebrow="Collections"
      layout="contained"
    >
      <CollectionDetailPage
        collection={collection}
        search={search.q}
        page={search.page ?? 1}
        onSearchChange={(next) =>
          navigate({
            search: (previous) => ({ ...previous, ...next }),
            replace: true,
          })
        }
      />
    </Page>
  );
}
