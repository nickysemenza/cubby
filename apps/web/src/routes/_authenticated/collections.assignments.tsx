import {
  createFileRoute,
  stripSearchParams,
  useNavigate,
} from "@tanstack/react-router";

import { CollectionAssignmentMatrix } from "~/app/collections/collection-assignment-matrix";
import { collectionAssignmentSearchSchema } from "~/app/collections/collection-assignment-search";
import { Page } from "~/components/page/Page";
import { pageTitle } from "~/lib/page-title";

export const Route = createFileRoute("/_authenticated/collections/assignments")(
  {
    validateSearch: collectionAssignmentSearchSchema,
    search: {
      middlewares: [
        stripSearchParams({
          subject: "product",
          page: 1,
          rows: 500,
          sort: "name-asc",
        }),
      ],
    },
    component: AssignmentsRoute,
    head: () => ({ meta: [{ title: pageTitle("Collection assignments") }] }),
  },
);

function AssignmentsRoute() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  return (
    <Page title="Collection assignments" eyebrow="Collections" layout="full">
      <CollectionAssignmentMatrix
        subject={search.subject ?? "product"}
        search={search.q}
        page={search.page ?? 1}
        pageSize={search.rows ?? 500}
        sort={search.sort ?? "name-asc"}
        collection={search.collection}
        membership={search.membership}
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
