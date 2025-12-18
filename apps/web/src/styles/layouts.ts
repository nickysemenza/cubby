import { cva, type VariantProps } from "class-variance-authority";

export const flexContainerVariants = cva("flex", {
  variants: {
    direction: {
      row: "flex-row",
      col: "flex-col",
    },
    align: {
      start: "items-start",
      center: "items-center",
      end: "items-end",
      stretch: "items-stretch",
    },
    justify: {
      start: "justify-start",
      center: "justify-center",
      end: "justify-end",
      between: "justify-between",
      around: "justify-around",
    },
    gap: {
      0: "gap-0",
      1: "gap-1",
      2: "gap-2",
      3: "gap-3",
      4: "gap-4",
      6: "gap-6",
      8: "gap-8",
    },
    wrap: {
      true: "flex-wrap",
      false: "flex-nowrap",
    },
  },
  defaultVariants: {
    direction: "row",
    align: "start",
    justify: "start",
    gap: 0,
  },
});

export const gridContainerVariants = cva("grid", {
  variants: {
    cols: {
      1: "grid-cols-1",
      2: "grid-cols-2",
      3: "grid-cols-3",
      4: "grid-cols-4",
      responsive2: "grid-cols-1 md:grid-cols-2",
      responsive3: "grid-cols-2 md:grid-cols-3 lg:grid-cols-4",
      responsive4: "grid-cols-3 sm:grid-cols-4 md:grid-cols-5",
    },
    gap: {
      0: "gap-0",
      1: "gap-1",
      2: "gap-2",
      3: "gap-3",
      4: "gap-4",
      6: "gap-6",
      8: "gap-8",
    },
  },
  defaultVariants: {
    cols: 1,
    gap: 4,
  },
});

export const spacedContainerVariants = cva("", {
  variants: {
    space: {
      0: "space-y-0",
      1: "space-y-1",
      2: "space-y-2",
      3: "space-y-3",
      4: "space-y-4",
      6: "space-y-6",
      8: "space-y-8",
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
