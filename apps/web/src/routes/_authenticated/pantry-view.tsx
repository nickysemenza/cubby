import { createFileRoute } from "@tanstack/react-router";
import { IsometricPantry } from "~/app/pantry-view/IsometricPantry";

export const Route = createFileRoute("/_authenticated/pantry-view")({
  component: PantryViewPage,
  head: () => ({ meta: [{ title: "Pantry View | cubby" }] }),
});

function PantryViewPage() {
  return (
    <div className="-mx-4 -mt-4 -mb-20 h-[calc(100dvh-4rem)] overflow-hidden md:-mx-6 md:-mb-4">
      <IsometricPantry />
    </div>
  );
}
