import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "~/lib/utils";

const pillVariants = cva(
  "inline-flex h-5 items-center rounded-[var(--brand-radius-chip)] border px-1.5 py-0.5 text-2xs font-medium",
  {
    variants: {
      mode: {
        value: "",
        suggestion:
          "border-dashed border-muted-foreground/40 bg-muted/40 text-muted-foreground",
      },
    },
    defaultVariants: {
      mode: "value",
    },
  },
);

/** Shared compact chip geometry for saved values and pending suggestions. */
function Pill({
  className,
  mode = "value",
  render,
  ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof pillVariants>) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      { className: cn(pillVariants({ mode, className })) },
      props,
    ),
    render,
    state: { slot: "pill", mode },
  });
}

export { Pill, pillVariants };
