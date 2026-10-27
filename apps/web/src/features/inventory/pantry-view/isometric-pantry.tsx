/**
 * React shell for the isometric pantry. Pure projection/layout lives in
 * isometric-geometry and isometric-scene; canvas lifecycle and pointer/touch
 * interaction live in use-isometric-pantry.
 */
import { formatCategoryLabel, getFeatureColor } from "@cubby/shared";
import { ArrowLeftIcon } from "@phosphor-icons/react/dist/csr/ArrowLeft";
import { ArrowsOutSimpleIcon } from "@phosphor-icons/react/dist/csr/ArrowsOutSimple";
import { CircleNotchIcon } from "@phosphor-icons/react/dist/csr/CircleNotch";
import { Link } from "@tanstack/react-router";
import { useMemo } from "react";

import { createActionFor } from "~/entity/actions/action-items";
import { Picker } from "~/ui/combobox/picker";
import type { PickerOption } from "~/ui/combobox/picker-option";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { useHydratedLoading } from "~/ui/hooks/use-hydrated";
import { Button } from "~/ui/primitives/button";

import { useIsometricPantry } from "./use-isometric-pantry";

function CategoryLegend({
  inventory,
}: {
  inventory: ReturnType<typeof useIsometricPantry>["inventory"];
}) {
  const categories = Array.from(
    new Map(
      inventory.flatMap((item) =>
        item.product.category
          ? [
              [
                item.product.category.id,
                {
                  category: item.product.category,
                  feature: item.categoryFeature,
                },
              ] as const,
            ]
          : [],
      ),
    ).values(),
  ).sort((a, b) =>
    formatCategoryLabel(a.category).localeCompare(
      formatCategoryLabel(b.category),
    ),
  );
  if (categories.length === 0) return null;
  return (
    <div className="absolute bottom-4 left-4 border border-[var(--border)] bg-card px-2 py-2">
      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
        {categories.map(({ category, feature }) => (
          <div key={category.id} className="flex items-center gap-2">
            <div
              className="size-2.5 shrink-0 rounded-sm"
              style={{ backgroundColor: getFeatureColor(feature) }}
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
    error,
    handleMouseDown,
    handleMouseLeave,
    handleMouseMove,
    handleMouseUp,
    inventory,
    isLoading: queryLoading,
    openLocation,
    resetView,
    retry,
    rooms,
  } = useIsometricPantry();

  // Hydration-stable: the server renders this branch with no tree, while the
  // client's first render already has the streamed one. See useHydratedLoading.
  const isLoading = useHydratedLoading(queryLoading);
  const addInventoryTarget = createActionFor("inventory");
  const roomOptions = useMemo<PickerOption[]>(
    () =>
      rooms.map((room) => ({
        value: room.locationId,
        label: room.name,
        hint: String(room.totalItemCount),
      })),
    [rooms],
  );

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center bg-background">
        <div className="flex items-center gap-2 text-muted-foreground">
          <CircleNotchIcon className="size-5 animate-spin" />
          <span>Loading pantry…</span>
        </div>
      </div>
    );
  }

  // Regression: a failed tree or inventory read drew "Your pantry is empty".
  if (error) {
    return (
      <div className="flex h-full items-center justify-center bg-background p-4">
        <ErrorDisplay error={error} title="the pantry" onRetry={retry} />
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
          <ArrowLeftIcon className="mr-1 size-4" />
          Back
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground hover:text-foreground"
          onClick={resetView}
        >
          <ArrowsOutSimpleIcon className="mr-1 size-4" />
          Reset View
        </Button>
        <Picker
          mode="choose"
          compact
          label="Open pantry location"
          placeholder="Open room…"
          className="ml-auto w-40"
          options={roomOptions}
          value={null}
          onValueChange={(shortcode) => {
            if (shortcode) openLocation(shortcode);
          }}
        />
      </div>
      <CategoryLegend inventory={inventory} />
    </div>
  );
}
