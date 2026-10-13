import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import { type ReactNode, useId, useState } from "react";

import { cn } from "~/lib/utils";
import { SectionHeading } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "~/ui/primitives/collapsible";

export interface FormSectionProps {
  /** Sentence-case section heading, shared with record and page regions. */
  title: string;
  /** Trailing header slot — e.g. a "+ Add" ghost button for a grid section. */
  action?: ReactNode;
  /** The first section skips the inter-section gap. */
  first?: boolean;
  /** Render the body behind a disclosure that starts closed. The open state
   * lives for the life of this mount only (not persisted), matching every
   * other in-form disclosure (`LabelNutritionFields`). */
  collapsed?: boolean;
  children: ReactNode;
}

/** Section spacing overrides the field stack once; disclosures retain local state. */
export function FormSection({
  title,
  action,
  first = false,
  collapsed = false,
  children,
}: FormSectionProps) {
  const [open, setOpen] = useState(!collapsed);
  const titleId = useId();
  const titleNode = collapsed ? (
    <CollapsibleTrigger
      render={
        <Button variant="ghost" size="sm" className="justify-start px-0" />
      }
    >
      <CaretRightIcon
        className={cn(
          "size-3.5 shrink-0 transition-transform",
          open && "rotate-90",
        )}
        aria-hidden
      />
      {title}
    </CollapsibleTrigger>
  ) : (
    title
  );
  const header = (
    <SectionHeading as="h4" id={titleId} title={titleNode} actions={action} />
  );
  return (
    <section
      aria-labelledby={titleId}
      className={cn("space-y-2", !first && "!mt-3")}
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
