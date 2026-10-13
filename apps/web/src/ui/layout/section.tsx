import type * as React from "react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import { stackVariants } from "~/styles/layouts";

/** One compact heading band for page regions, record sections, and dashboards. */
export function SectionHeading({
  title,
  description,
  actions,
  meta,
  as: Heading = "h2",
  id,
  muted = false,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  meta?: ReactNode;
  as?: "h2" | "h3" | "h4";
  id?: string;
  muted?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-sm bg-muted/60 px-2 py-1">
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          {title && (
            <Heading
              id={id}
              className={cn(
                "flex min-w-0 items-center gap-2 text-[0.8125rem] font-semibold",
                muted && "text-muted-foreground",
              )}
            >
              {title}
            </Heading>
          )}
          {meta}
        </div>
        {description && (
          <p className="mt-1 text-xs text-muted-foreground">{description}</p>
        )}
      </div>
      {actions && <div className="max-w-full min-w-0">{actions}</div>}
    </div>
  );
}

interface SectionProps extends Omit<
  React.HTMLAttributes<HTMLElement>,
  "title"
> {
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
      {hasHeader && <SectionHeading title={title} description={description} />}
      {children}
    </section>
  );
}

Section.displayName = "Section";
