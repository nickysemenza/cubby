import { createFileRoute } from "@tanstack/react-router";
import { getDocSection } from "~/app/docs/docs-registry";

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

  return entry.render();
}
