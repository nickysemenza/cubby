import {
  createFileRoute,
  stripSearchParams,
  useNavigate,
} from "@tanstack/react-router";
import { z } from "zod";
import { CollectionAssignmentMatrix } from "~/app/collections/collection-assignment-matrix";
import { Page } from "~/components/page/Page";
import { pageTitle } from "~/lib/page-title";
import { urlStringParam } from "~/lib/search-params";

const searchSchema = z.object({
  subject: z.enum(["product", "location"]).optional().catch(undefined),
  q: urlStringParam,
  page: z.coerce.number().int().positive().optional().catch(undefined),
});

export const Route = createFileRoute("/_authenticated/collections/assignments")(
  {
    validateSearch: searchSchema,
    search: {
      middlewares: [stripSearchParams({ subject: "product", page: 1 })],
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
