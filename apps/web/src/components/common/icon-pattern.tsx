import { BowlFoodIcon } from "@phosphor-icons/react/dist/csr/BowlFood";
import { CarrotIcon } from "@phosphor-icons/react/dist/csr/Carrot";
import { ChefHatIcon } from "@phosphor-icons/react/dist/csr/ChefHat";
import { CookingPotIcon } from "@phosphor-icons/react/dist/csr/CookingPot";
import { ForkKnifeIcon } from "@phosphor-icons/react/dist/csr/ForkKnife";
import { GrainsIcon } from "@phosphor-icons/react/dist/csr/Grains";
import { HamburgerIcon } from "@phosphor-icons/react/dist/csr/Hamburger";
import { PackageIcon } from "@phosphor-icons/react/dist/csr/Package";
import { PintGlassIcon } from "@phosphor-icons/react/dist/csr/PintGlass";
import { WarehouseIcon } from "@phosphor-icons/react/dist/csr/Warehouse";
import { useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";

const patternIcons = [
  PackageIcon,
  ForkKnifeIcon,
  ChefHatIcon,
  CarrotIcon,
  CookingPotIcon,
  BowlFoodIcon,
  WarehouseIcon,
  BowlFoodIcon,
  PintGlassIcon,
  HamburgerIcon,
  GrainsIcon,
];

// Seeded random for consistent positions across renders
const seededRandom = (seed: number) => {
  const x = Math.sin(seed * 9999) * 10000;
  return x - Math.floor(x);
};

// Footprint of a single cell (icon + gap) in px. Used to compute how many
// icons are needed to cover the container at any size.
const CELL_SIZE = 44;

interface IconPatternProps {
  /** Extra classes for the overlay container (e.g. opacity, positioning). */
  className?: string;
}

/**
 * A faint, tiled field of food-related icons used as a decorative background.
 *
 * The grid measures its own container and renders exactly enough icons to
 * cover it, so it fills the full area at any viewport size instead of
 * bunching at the top. Purely decorative — hidden from assistive tech and
 * non-interactive.
 */
export function IconPattern({ className }: IconPatternProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [{ cols, count }, setGrid] = useState({ cols: 12, count: 0 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const update = () => {
      const cols = Math.max(1, Math.ceil(el.clientWidth / CELL_SIZE));
      const rows = Math.max(1, Math.ceil(el.clientHeight / CELL_SIZE));
      setGrid({ cols, count: cols * rows });
    };

    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={cn(
        "pointer-events-none absolute inset-0 overflow-hidden opacity-[0.04]",
        className,
      )}
      aria-hidden="true"
    >
      <div
        className="grid place-items-center gap-4"
        style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
      >
        {Array.from({ length: count }).map((_, i) => {
          const iconIndex = Math.floor(
            seededRandom(i * 7) * patternIcons.length,
          );
          // iconIndex = floor(rand * length) with rand < 1, so always in-bounds
          const Icon = patternIcons[iconIndex]!;
          const rotation = seededRandom(i * 13) * 40 - 20;
          const scale = 0.7 + seededRandom(i * 17) * 0.5;
          return (
            <Icon
              // oxlint-disable-next-line react/no-array-index-key -- This fixed decorative pattern never reorders or preserves icon state.
              key={i}
              className="size-5 text-foreground"
              style={{
                transform: `rotate(${rotation}deg) scale(${scale})`,
              }}
            />
          );
        })}
      </div>
    </div>
  );
}
