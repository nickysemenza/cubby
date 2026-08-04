import { createFileRoute } from "@tanstack/react-router";
import { IsometricPantry } from "~/app/pantry-view/IsometricPantry";
import { pageTitle } from "~/lib/page-title";

export const Route = createFileRoute("/_authenticated/pantry-view")({
  component: PantryViewPage,
  head: () => ({ meta: [{ title: pageTitle("Pantry view") }] }),
});

function PantryViewPage() {
  // negative bottom margin cancels the root mobile-nav clearance for a full-bleed view
  return (
    <div className="-mx-4 -mt-4 -mb-20 h-[calc(100dvh-4rem)] overflow-hidden md:-mx-6 md:-mb-4">
      <IsometricPantry />
    </div>
  );
}
