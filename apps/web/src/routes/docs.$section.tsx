import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { Suspense, useId } from "react";

import { DEFAULT_DOC_SLUG, getDocSection } from "~/app/docs/docs-registry";
import { SimpleLoading } from "~/components/feedback/loading-skeletons";
import { Button } from "~/components/ui/button";
import { pageTitle } from "~/lib/page-title";

export const Route = createFileRoute("/docs/$section")({
  // The registry's own title, not the raw slug — the section is already
  // resolved synchronously below, so the tab can say "Concepts" over
  // "concepts". An unknown slug renders the not-found body; leave it unnamed.
  head: ({ params }) => ({
    meta: [{ title: pageTitle(getDocSection(params.section)?.title, "Docs") }],
  }),
  loader: ({ params }) => {
    if (!getDocSection(params.section)) throw notFound();
  },
  notFoundComponent: DocsSectionNotFound,
  component: DocsSectionRoute,
});

function DocsSectionNotFound() {
  const headingId = useId();

  return (
    <section
      aria-labelledby={headingId}
      className="border-y border-border bg-card px-4 py-6 sm:px-6"
    >
      <div className="max-w-prose">
        <h2 id={headingId} className="text-lg font-semibold">
          Documentation section not found
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          This link is no longer available. Browse the current documentation to
          continue.
        </p>
        <Button
          className="mt-4"
          render={
            <Link to="/docs/$section" params={{ section: DEFAULT_DOC_SLUG }} />
          }
          nativeButton={false}
        >
          Browse documentation
        </Button>
      </div>
    </section>
  );
}

function DocsSectionRoute() {
  const { section } = Route.useParams();
  const entry = getDocSection(section);

  if (!entry) throw notFound();

  // Sections are lazy (see docs-registry) — render under a Suspense boundary.
  return <Suspense fallback={<SimpleLoading />}>{entry.render()}</Suspense>;
}
