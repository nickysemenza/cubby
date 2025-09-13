import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "~/lib/utils";

const imageGridVariants = cva("grid", {
  variants: {
    variant: {
      images: "grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5",
      responsive2: "grid-cols-1 gap-4 md:grid-cols-2",
      responsive3: "grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4",
      responsive4: "grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5",
    },
  },
  defaultVariants: {
    variant: "images",
  },
});

export interface ImageGridProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof imageGridVariants> {}

export const ImageGrid = React.forwardRef<HTMLDivElement, ImageGridProps>(
  ({ className, variant, ...props }, ref) => {
    return (
      <div
        className={cn(imageGridVariants({ variant }), className)}
        ref={ref}
        {...props}
      />
    );
  },
);

ImageGrid.displayName = "ImageGrid";
