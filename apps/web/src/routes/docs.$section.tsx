import { createFileRoute } from "@tanstack/react-router";
import { Suspense } from "react";
import { getDocSection } from "~/app/docs/docs-registry";
import { SimpleLoading } from "~/components/feedback/loading-skeletons";

export const Route = createFileRoute("/docs/$section")({
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
