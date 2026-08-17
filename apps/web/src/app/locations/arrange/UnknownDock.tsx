import { dropTargetForElements } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import type { InfLocation } from "@cubby/schemas/location";
import { HelpCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Row, Stack } from "~/components/layout";
import { Description } from "~/components/ui/description";
import { cn } from "~/lib/utils";
import { ArrangeItemChip } from "./ArrangeItemChip";
import { ArrangeLocationRow } from "./ArrangeLocationRow";
import { isValidItemDrop, isValidLocationDrop } from "./arrange-tree-utils";
import { type ArrangeDropData, asDragData } from "./arrange-types";

/** The dock has no zoom/breadcrumb of its own, so drilling here is a no-op. */
function noopDrill() {}

interface UnknownDockProps {
  unknownRoot: InfLocation | null;
  roots: InfLocation[];
}

/**
 * Docked panel for the global "Unknown" staging location — a always-visible
 * drop target for items/locations you haven't sorted yet. `unknownRoot` is
 * provisioned lazily by the parent (`ArrangeSurface`), so it renders a muted
 * placeholder until it exists.
 */
export function UnknownDock({ unknownRoot, roots }: UnknownDockProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [isOver, setIsOver] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element || !unknownRoot) return;
    const targetId = unknownRoot.id;

    return dropTargetForElements({
      element,
      getData: (): ArrangeDropData & Record<string, unknown> => ({
        arrangeTarget: true,
        locationId: targetId,
      }),
      canDrop: ({ source }) => {
        const d = asDragData(source.data);
        if (!d) return false;
        if (d.arrangeDrag === "location") {
          return isValidLocationDrop(roots, d.locationId, targetId);
        }
        return isValidItemDrop(roots, d.sourceLocationId, targetId);
      },
      onDragEnter: () => setIsOver(true),
      onDragLeave: () => setIsOver(false),
      onDrop: () => setIsOver(false),
    });
  }, [unknownRoot, roots]);

  if (!unknownRoot) {
    return (
      <Stack
        gap="sm"
        className="w-full shrink-0 rounded border border-[var(--border-strong)] border-dashed bg-background p-4 lg:w-72"
      >
        <Description size="sm">Unknown staging — provisioning…</Description>
      </Stack>
    );
  }

  const children = unknownRoot.children ?? [];
  const items = unknownRoot.inventoryItems ?? [];
  const count = children.length + items.length;
  const isEmpty = count === 0;

  return (
    <Stack
      ref={ref}
      gap="sm"
      className={cn(
        "w-full shrink-0 rounded border border-[var(--border-strong)] border-dashed bg-background p-4 lg:w-72",
        isOver && "bg-primary/10",
      )}
    >
      <Row align="center" gap="sm">
        <HelpCircle className="size-4 text-muted-foreground" />
        <span className="font-medium text-sm">Unknown</span>
        <Description as="span" size="2xs" className="ml-auto">
          {count}
        </Description>
      </Row>

      {isEmpty ? (
        <Description size="xs">
          Drop anything here to stage it, then drill elsewhere and drag it back
          out.
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
          {items.length > 0 && (
            <Stack gap="tight">
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
      )}
    </Stack>
  );
}
