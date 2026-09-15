import { createFileRoute, redirect } from "@tanstack/react-router";

// The standalone plantings list is gone — Garden Home (`/garden`) is the
// single landing page for plantings, growing areas, and journal entries.
// The route stays (existing links, bookmarks, `routes.list` on the `planting`
// entity definition) and just forwards visitors to the page that replaced it.
export const Route = createFileRoute("/_authenticated/plantings/")({
  beforeLoad: () => {
    throw redirect({ to: "/garden", replace: true });
  },
});
