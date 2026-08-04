import { createFileRoute } from "@tanstack/react-router";
import { Suspense } from "react";
import { getDocSection } from "~/app/docs/docs-registry";
import { SimpleLoading } from "~/components/feedback/loading-skeletons";
import { pageTitle } from "~/lib/page-title";

export const Route = createFileRoute("/docs/$section")({
  // The registry's own title, not the raw slug — the section is already
  // resolved synchronously below, so the tab can say "Concepts" over
  // "concepts". An unknown slug renders the not-found body; leave it unnamed.
  head: ({ params }) => ({
    meta: [{ title: pageTitle(getDocSection(params.section)?.title, "Docs") }],
  }),
  component: DocsSectionRoute,
});

function DocsSectionRoute() {
  const { section } = Route.useParams();
  const entry = getDocSection(section);

  if (!entry) {
    return (
      <p className="text-muted-foreground text-sm">
        No documentation section named "{section}".
      </p>
    );
  }

  // Sections are lazy (see docs-registry) — render under a Suspense boundary.
  return <Suspense fallback={<SimpleLoading />}>{entry.render()}</Suspense>;
}
