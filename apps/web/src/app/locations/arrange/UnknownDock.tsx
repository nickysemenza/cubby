import type { InfLocation } from "@cubby/schemas/location";
import { QuestionIcon as HelpCircle } from "@phosphor-icons/react/dist/csr/Question";

import { Row, Stack } from "~/components/layout";
import { Description } from "~/components/ui/description";
import { cn } from "~/lib/utils";

import { ArrangeItemChip } from "./ArrangeItemChip";
import { ArrangeLocationRow } from "./ArrangeLocationRow";
import { useArrangeDropTarget } from "./use-arrange-drop-target";

function noopDrill() {}
interface UnknownDockProps {
  unknownRoot: InfLocation | null;
  roots: InfLocation[];
}

/** A deliberately separate staging destination, rather than the board's default view. */
export function UnknownDock({ unknownRoot, roots }: UnknownDockProps) {
  const { setNodeRef, isOver } = useArrangeDropTarget({
    roots,
    locationId: unknownRoot?.id ?? null,
  });
  if (!unknownRoot)
    return (
      <Stack
        gap="sm"
        className="w-full shrink-0 rounded-none border border-dashed border-[var(--border-strong)] bg-background p-4 lg:w-72"
      >
        <Description size="sm">Unknown staging — provisioning…</Description>
      </Stack>
    );
  const children = unknownRoot.children ?? [];
  const items = unknownRoot.inventoryItems ?? [];
  const count = children.length + items.length;
  return (
    <Stack
      as="fieldset"
      ref={setNodeRef}
      aria-label="Unknown staging drop target"
      gap="sm"
      className={cn(
        "w-full shrink-0 rounded-none border border-dashed border-[var(--border-strong)] bg-background p-4 lg:w-72",
        isOver && "bg-primary/10",
      )}
    >
      <Row align="center" gap="sm">
        <HelpCircle className="size-4 text-muted-foreground" />
        <span className="text-sm font-medium">Unknown staging</span>
        <Description as="span" size="2xs" className="ml-auto">
          {count}
        </Description>
      </Row>
      {count === 0 ? (
        <Description size="xs">
          Drop anything here to stage it, then move it back out when its home is
          known.
        </Description>
      ) : (
        <Stack gap="xs">
          {children.map((child) => (
            <ArrangeLocationRow
              key={child.id}
              node={child}
              roots={roots}
              depth={0}
              onDrill={noopDrill}
            />
          ))}
          {items.map((item) => (
            <ArrangeItemChip
              key={item.id}
              item={item}
              sourceLocationId={unknownRoot.id}
              roots={roots}
            />
          ))}
        </Stack>
      )}
    </Stack>
  );
}
