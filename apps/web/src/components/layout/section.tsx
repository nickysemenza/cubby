import type * as React from "react";
import type { ReactNode } from "react";
import { cn } from "~/lib/utils";
import { stackVariants } from "~/styles/layouts";
import { Stack } from "./stack";

interface SectionProps
  extends Omit<React.HTMLAttributes<HTMLElement>, "title"> {
  /** Section heading (rendered as an `h2`). */
  title?: ReactNode;
  /** Muted sub-line under the title. */
  description?: ReactNode;
  ref?: React.Ref<HTMLElement>;
}

/**
 * A titled, transparent page region: an optional `title / description` header
 * over a {@link Stack} body. Owns the section heading typography in one place.
 * Use {@link Card} instead when the content needs a bordered/elevated surface.
 */
export function Section({
  title,
  description,
  className,
  children,
  ref,
  ...props
}: SectionProps) {
  const hasHeader = title || description;
  return (
    <section
      className={cn(stackVariants({ gap: "md" }), className)}
      ref={ref}
      {...props}
    >
      {hasHeader && (
        <Stack gap="tight" className="border-border border-b pb-1">
          {title && (
            <h2 className="font-heading font-semibold text-sm">{title}</h2>
          )}
          {description && (
            <p className="text-muted-foreground text-xs">{description}</p>
          )}
        </Stack>
      )}
      {children}
    </section>
  );
}

Section.displayName = "Section";
