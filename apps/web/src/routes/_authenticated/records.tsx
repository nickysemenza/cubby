import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { ApplicationDirectory } from "~/app/_components/navigation/application-directory";
import { pageTitle } from "~/lib/page-title";

export const Route = createFileRoute("/_authenticated/records")({
  validateSearch: z.object({ q: z.string().optional() }),
  head: () => ({ meta: [{ title: pageTitle("Records") }] }),
  component: RecordsPage,
});

function RecordsPage() {
  const { q } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <ApplicationDirectory
      mode="records"
      query={q ?? ""}
      onQueryChange={(query) => {
        void navigate({ search: query ? { q: query } : {}, replace: true });
      }}
    />
  );
}
