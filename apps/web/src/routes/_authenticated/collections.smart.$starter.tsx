import {
  SMART_COLLECTION_STARTERS,
  smartCollectionKey,
} from "@cubby/schemas/collection";
import {
  createFileRoute,
  notFound,
  stripSearchParams,
  useNavigate,
} from "@tanstack/react-router";
import { z } from "zod";

import { SmartCollectionPage } from "~/app/collections/smart-collection-page";
import { useSmartCollections } from "~/app/collections/smart-collection-state";
import { Page } from "~/components/page/Page";
import { pageTitle } from "~/lib/page-title";
import { urlStringParam } from "~/lib/search-params";

const searchSchema = z.object({
  q: urlStringParam,
  page: z.coerce.number().int().positive().optional().catch(undefined),
});

export const Route = createFileRoute(
  "/_authenticated/collections/smart/$starter",
)({
  beforeLoad: ({ params }) => {
    if (!smartCollectionKey.safeParse(params.starter).success) {
      throw notFound();
    }
  },
  validateSearch: searchSchema,
  search: { middlewares: [stripSearchParams({ page: 1 })] },
  component: SmartCollectionRoute,
  head: ({ params }) => {
    const parsed = smartCollectionKey.safeParse(params.starter);
    const starter = parsed.success
      ? SMART_COLLECTION_STARTERS.find((item) => item.key === parsed.data)
      : undefined;
    return {
      meta: [{ title: pageTitle(starter?.name ?? "Smart Collection") }],
    };
  },
});

function SmartCollectionRoute() {
  const params = Route.useParams();
  const starter = smartCollectionKey.parse(params.starter);
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { drafts } = useSmartCollections();

  return (
    <Page
      title={drafts[starter].name}
      eyebrow="Smart Collections"
      layout="contained"
    >
      <SmartCollectionPage
        starterKey={starter}
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
