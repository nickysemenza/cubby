import { CaretRightIcon as ChevronRight } from "@phosphor-icons/react/dist/csr/CaretRight";
import { type ReactNode, useId, useState } from "react";

import { Row } from "~/components/layout";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "~/components/ui/collapsible";
import { cn } from "~/lib/utils";

export interface FormSectionProps {
  /** Sentence-case section title (DESIGN.md: sentence case, not a heading). */
  title: string;
  /** Trailing header slot — e.g. a "+ Add" ghost button for a grid section. */
  action?: ReactNode;
  /** The first section in a stack skips the leading hairline and extra gap —
   * whatever precedes it (the dialog edge, or ungrouped `main` fields) is
   * already visually separate. */
  first?: boolean;
  /** Render the body behind a disclosure that starts closed. The open state
   * lives for the life of this mount only (not persisted), matching every
   * other in-form disclosure (`LabelNutritionFields`). */
  collapsed?: boolean;
  children: ReactNode;
}

/**
 * One editor section: a sentence-case 12px/500 secondary title, an optional
 * trailing action, and a single hairline above every section but the first —
 * no plate card, since the dialog is already a surface (DESIGN.md: "no
 * equal-weight cards"). Promoted from the product form's local `FormSection`
 * (`product-form-fields.tsx`, left in place there — PR 3 deletes that file)
 * so every generated and hand-written form shares one section grammar.
 *
 * `!mt-5` overrides the dialog body's ambient `space-y-3.5` (14px,
 * `dialog-form-body` in `form-utils.tsx`) with the design's 20px
 * section-to-section gap regardless of where the section lands in that
 * stack — two adjacent margins on the same box would otherwise combine
 * unpredictably depending on sibling order.
 */
export function FormSection({
  title,
  action,
  first = false,
  collapsed = false,
  children,
}: FormSectionProps) {
  const [open, setOpen] = useState(!collapsed);
  const titleId = useId();
  const titleNode = (
    <Row
      as="h4"
      id={titleId}
      align="center"
      gap="xs"
      className="my-0 text-xs font-medium text-muted-foreground"
    >
      {collapsed && (
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 transition-transform",
            open && "rotate-90",
          )}
          aria-hidden
        />
      )}
      {title}
    </Row>
  );
  const header = (
    <Row align="center" justify="between" gap="sm">
      {collapsed ? (
        <CollapsibleTrigger
          render={<Row as="button" type="button" className="text-left" />}
        >
          {titleNode}
        </CollapsibleTrigger>
      ) : (
        titleNode
      )}
      {action}
    </Row>
  );
  return (
    <section
      aria-labelledby={titleId}
      className={cn("space-y-2", !first && "!mt-5 border-t border-border pt-2")}
    >
      {collapsed ? (
        <Collapsible open={open} onOpenChange={setOpen}>
          {header}
          <CollapsibleContent>
            <div className="space-y-2 pt-2">{children}</div>
          </CollapsibleContent>
        </Collapsible>
      ) : (
        <>
          {header}
          {children}
        </>
      )}
    </section>
  );
}
