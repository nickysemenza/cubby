import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { pageTitle } from "~/lib/page-title";
import { ApplicationDirectory } from "~/ui/navigation/application-directory";

export const Route = createFileRoute("/_authenticated/activities")({
  validateSearch: z.object({ q: z.string().optional() }),
  head: () => ({ meta: [{ title: pageTitle("Activities") }] }),
  component: ActivitiesPage,
});

function ActivitiesPage() {
  const { q } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <ApplicationDirectory
      mode="activities"
      query={q ?? ""}
      onQueryChange={(query) => {
        void navigate({ search: query ? { q: query } : {}, replace: true });
      }}
    />
  );
}
