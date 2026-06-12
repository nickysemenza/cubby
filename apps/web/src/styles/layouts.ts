import { cva, type VariantProps } from "class-variance-authority";

export const flexContainerVariants = cva("flex", {
  variants: {
    align: {
      center: "items-center",
      end: "items-end",
    },
    justify: {
      end: "justify-end",
    },
    gap: {
      1: "gap-1",
      2: "gap-2",
    },
  },
});

export const gridContainerVariants = cva("grid gap-4", {
  variants: {
    cols: {
      cards3: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3",
      thumbs: "grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5",
      images: "grid-cols-3 sm:grid-cols-4 md:grid-cols-5",
      // auto-fit stretches the present metrics to fill the row (4 for recipe/
      // inventory, up to 6 for nutrition) instead of pinning to 8 fixed columns
      // and leaving dead space; the 7rem floor wraps to 2–3 across on mobile.
      summary: "grid-cols-[repeat(auto-fit,minmax(7rem,1fr))]",
    },
    gap: {
      2: "gap-2",
      4: "gap-4",
    },
  },
  defaultVariants: {
    gap: 4,
  },
});

export const spacedContainerVariants = cva("space-y-4", {
  variants: {
    space: {
      0: "space-y-0",
      4: "space-y-4",
    },
  },
  defaultVariants: {
    space: 4,
  },
});

export type FlexContainerVariants = VariantProps<typeof flexContainerVariants>;
export type GridContainerVariants = VariantProps<typeof gridContainerVariants>;
export type SpacedContainerVariants = VariantProps<
  typeof spacedContainerVariants
>;
