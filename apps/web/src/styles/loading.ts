import { cva, type VariantProps } from "class-variance-authority";

export const loadingSpinnerVariants = cva(
  "animate-spin rounded-full border-t-2 border-b-2",
  {
    variants: {
      size: {
        sm: "h-3 w-3",
        default: "h-4 w-4",
        lg: "h-6 w-6",
        xl: "h-8 w-8",
      },
      color: {
        default: "border-foreground",
        primary: "border-primary",
        white: "border-white",
      },
    },
    defaultVariants: {
      size: "default",
      color: "default",
    },
  },
);

export const loadingContainerVariants = cva("flex items-center", {
  variants: {
    justify: {
      start: "justify-start",
      center: "justify-center",
      end: "justify-end",
    },
    spacing: {
      none: "",
      sm: "space-x-1",
      default: "space-x-2",
      lg: "space-x-4",
    },
  },
  defaultVariants: {
    justify: "center",
    spacing: "default",
  },
});

export type LoadingSpinnerVariants = VariantProps<
  typeof loadingSpinnerVariants
>;
export type LoadingContainerVariants = VariantProps<
  typeof loadingContainerVariants
>;
