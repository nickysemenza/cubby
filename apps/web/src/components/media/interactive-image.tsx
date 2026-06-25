import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { Image } from "~/components/ui/image";
import { cn } from "~/lib/utils";

const interactiveImageVariants = cva(
  [
    "relative overflow-hidden rounded-md border border-[var(--border)]",
    "transition-colors",
  ],
  {
    variants: {
      aspectRatio: {
        square: "aspect-square",
        video: "aspect-video",
        auto: "",
      },
      hoverEffect: {
        none: "",
        borderPrimary: "hover:border-primary",
        scale: "group-hover:scale-105",
        both: "hover:border-primary group-hover:scale-105",
      },
      transition: {
        none: "",
        colors: "transition-colors",
        transform: "transition-transform duration-300",
        all: "transition-all duration-300",
      },
    },
    defaultVariants: {
      aspectRatio: "square",
      hoverEffect: "borderPrimary",
      transition: "colors",
    },
  },
);

const imageContentVariants = cva("object-cover", {
  variants: {
    transition: {
      none: "",
      transform: "transition-transform duration-300",
      scale: "transition-transform duration-300 group-hover:scale-105",
    },
  },
  defaultVariants: {
    transition: "scale",
  },
});

interface InteractiveImageProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "children">,
    VariantProps<typeof interactiveImageVariants> {
  src: string;
  alt: string;
  imageTransition?: VariantProps<typeof imageContentVariants>["transition"];
  imageClassName?: string;
}

export const InteractiveImage = ({
  className,
  aspectRatio,
  hoverEffect,
  transition,
  src,
  alt,
  imageTransition = "scale",
  imageClassName,
  ref,
  ...props
}: InteractiveImageProps & {
  ref?: React.Ref<HTMLDivElement>;
}) => {
  return (
    <div
      className={cn(
        interactiveImageVariants({ aspectRatio, hoverEffect, transition }),
        className,
      )}
      ref={ref}
      {...props}
    >
      <Image
        src={src}
        alt={alt}
        className={cn(
          "absolute inset-0 h-full w-full object-cover",
          imageContentVariants({ transition: imageTransition }),
          imageClassName,
        )}
      />
    </div>
  );
};

InteractiveImage.displayName = "InteractiveImage";
