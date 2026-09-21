/**
 * React shell for the isometric pantry. Pure projection/layout lives in
 * isometric-geometry and isometric-scene; canvas lifecycle and pointer/touch
 * interaction live in use-isometric-pantry.
 */
import { formatCategoryLabel, getCategoryColor } from "@cubby/shared";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, Loader2, Maximize2 } from "lucide-react";

import { createActionFor } from "~/app/_components/actions/action-items";
import { Button } from "~/components/ui/button";
import { NativeSelect } from "~/components/ui/native-select";
import { useHydratedLoading } from "~/hooks/useHydrated";

import { useIsometricPantry } from "./use-isometric-pantry";

function CategoryLegend({
  inventory,
}: {
  inventory: ReturnType<typeof useIsometricPantry>["inventory"];
}) {
  const categories = Array.from(
    new Map(
      inventory
        .map((item) => item.product.category)
        .filter((category) => category != null)
        .map((category) => [category.id, category]),
    ).values(),
  ).sort((a, b) =>
    formatCategoryLabel(a).localeCompare(formatCategoryLabel(b)),
  );
  if (categories.length === 0) return null;
  return (
    <div className="absolute bottom-4 left-4 border border-[var(--border)] bg-card px-2 py-2">
      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
        {categories.map((category) => (
          <div key={category.id} className="flex items-center gap-2">
            <div
              className="size-2.5 shrink-0 rounded-sm"
              style={{ backgroundColor: getCategoryColor(category) }}
            />
            <span className="text-2xs leading-none text-muted-foreground">
              {formatCategoryLabel(category)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function IsometricPantry() {
  const {
    canvasRef,
    containerRef,
    handleMouseDown,
    handleMouseLeave,
    handleMouseMove,
    handleMouseUp,
    inventory,
    isLoading: queryLoading,
    openLocation,
    resetView,
    rooms,
  } = useIsometricPantry();

  // Hydration-stable: the server renders this branch with no tree, while the
  // client's first render already has the streamed one. See useHydratedLoading.
  const isLoading = useHydratedLoading(queryLoading);
  const addInventoryTarget = createActionFor("inventory");

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center bg-background">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
          <span>Loading pantry...</span>
        </div>
      </div>
    );
  }

  if (inventory.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center bg-background text-muted-foreground">
        <p className="text-lg">Your pantry is empty</p>
        <p className="mt-2 text-sm">
          Add some inventory items to see them here
        </p>
        {addInventoryTarget && (
          <Link
            to={addInventoryTarget.to}
            search={addInventoryTarget.search}
            className="mt-4"
          >
            <Button variant="outline">Add Inventory</Button>
          </Link>
        )}
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative h-full w-full">
      <canvas
        ref={canvasRef}
        className="block h-full w-full touch-none"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
      />
      <div className="absolute inset-x-4 top-4 flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground hover:text-foreground"
          render={<Link to="/inventory" />}
          nativeButton={false}
        >
          <ArrowLeft className="mr-1 size-4" />
          Back
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground hover:text-foreground"
          onClick={resetView}
        >
          <Maximize2 className="mr-1 size-4" />
          Reset View
        </Button>
        <NativeSelect
          aria-label="Open pantry location"
          className="ml-auto max-w-40 min-w-0 bg-card"
          defaultValue=""
          onChange={(event) => {
            const shortcode = event.currentTarget.value;
            if (shortcode) openLocation(shortcode);
          }}
        >
          <option value="" disabled>
            Open room…
          </option>
          {rooms.map((room) => (
            <option key={room.locationId} value={room.locationId}>
              {room.name} · {room.totalItemCount}
            </option>
          ))}
        </NativeSelect>
      </div>
      <CategoryLegend inventory={inventory} />
    </div>
  );
}
