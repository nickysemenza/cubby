/**
 * React shell for the isometric pantry. Pure projection/layout lives in
 * isometric-geometry and isometric-scene; canvas lifecycle and pointer/touch
 * interaction live in use-isometric-pantry.
 */
import {
  formatCategoryLabel,
  getCategoryColor,
  productCategoryValues,
} from "@cubby/shared";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, Loader2, Maximize2 } from "lucide-react";
import { Button } from "~/components/ui/button";
import { useIsometricPantry } from "./use-isometric-pantry";

function CategoryLegend() {
  return (
    <div className="absolute bottom-4 left-4 rounded-lg border border-[var(--border)] bg-card/90 px-2 py-2 backdrop-blur-sm">
      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
        {productCategoryValues.map((cat) => (
          <div key={cat} className="flex items-center gap-2">
            <div
              className="size-2.5 shrink-0 rounded-sm"
              style={{ backgroundColor: getCategoryColor(cat) }}
            />
            <span className="text-2xs text-muted-foreground leading-none">
              {formatCategoryLabel(cat)}
            </span>
          </div>
        ))}
        <div className="flex items-center gap-2">
          <div
            className="size-2.5 shrink-0 rounded-sm"
            style={{ backgroundColor: getCategoryColor(null) }}
          />
          <span className="text-2xs text-muted-foreground leading-none">
            uncategorized
          </span>
        </div>
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
    isLoading,
    resetView,
  } = useIsometricPantry();

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
        <Link to="/inventory/new" className="mt-4">
          <Button variant="outline">Add Inventory</Button>
        </Link>
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
      <Link to="/inventory" className="absolute top-4 left-4">
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="mr-1 size-4" />
          Back
        </Button>
      </Link>
      <Button
        variant="ghost"
        size="sm"
        className="absolute top-4 right-48 text-muted-foreground hover:text-foreground"
        onClick={resetView}
      >
        <Maximize2 className="mr-1 size-4" />
        Reset View
      </Button>
      <CategoryLegend />
    </div>
  );
}
