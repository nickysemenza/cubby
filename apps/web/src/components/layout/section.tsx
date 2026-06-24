import type * as React from "react";
import type { ReactNode } from "react";
import { Eyebrow } from "~/components/ui/eyebrow";
import { cn } from "~/lib/utils";
import { stackVariants } from "~/styles/layouts";
import { Row } from "./row";
import { Stack } from "./stack";

interface SectionProps
  extends Omit<React.HTMLAttributes<HTMLElement>, "title"> {
  /** Section heading (rendered as the configured heading level). */
  title?: ReactNode;
  /** Muted sub-line under the title. */
  description?: ReactNode;
  /** Mono micro-label above the title. */
  eyebrow?: ReactNode;
  /** Right-aligned action cluster on the header row. */
  actions?: ReactNode;
  /** Vertical gap between header and body (and between body children). */
  gap?: "sm" | "md" | "lg";
  /** Semantic heading level (visual size is constant). */
  headingAs?: "h2" | "h3";
  ref?: React.Ref<HTMLElement>;
}

/**
 * A titled, transparent page region: an optional `eyebrow / title / description`
 * header (+ right-aligned `actions`) over a {@link Stack} body. Owns the section
 * heading typography in one place. Use {@link Card} instead when the content
 * needs a bordered/elevated surface.
 */
export function Section({
  title,
  description,
  eyebrow,
  actions,
  gap = "md",
  headingAs: Heading = "h2",
  className,
  children,
  ref,
  ...props
}: SectionProps) {
  const hasHeader = title || eyebrow || description || actions;
  return (
    <section
      className={cn(stackVariants({ gap }), className)}
      ref={ref}
      {...props}
    >
      {hasHeader && (
        <Row justify="between" align="start" gap="md">
          <Stack gap="tight">
            {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
            {title && (
              <Heading className="font-heading font-semibold text-lg">
                {title}
              </Heading>
            )}
            {description && (
              <p className="text-muted-foreground text-xs">{description}</p>
            )}
          </Stack>
          {actions && <Row gap="sm">{actions}</Row>}
        </Row>
      )}
      {children}
    </section>
  );
}

Section.displayName = "Section";
