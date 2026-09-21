import type { LocationShortcode } from "@cubby/schemas/identifiers";
import type { InfLocation } from "@cubby/schemas/location";
import {
  type CollisionDetection,
  closestCorners,
  DndContext,
  type DragEndEvent,
  type DragMoveEvent,
  DragOverlay,
  type DragStartEvent,
  pointerWithin,
} from "@dnd-kit/core";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  createDndAnnouncements,
  cubbyDndScreenReaderInstructions,
} from "~/components/dnd/accessibility";
import { createDndAutoScroller } from "~/components/dnd/auto-scroll";
import { DragPreviewFrame } from "~/components/dnd/DragPreviewFrame";
import {
  createValidTargetKeyboardCoordinates,
  useCubbyDndSensors,
} from "~/components/dnd/sensors";

import { canDropOnArrangeTarget } from "./arrange-drop-policy";
import {
  type ArrangeDragData,
  asDragData,
  asDropData,
  type ItemDragData,
} from "./arrange-types";

/** Also used by ArrangeThumb to suppress image previews while a drag is active. */
const DRAGGING_CLASS = "arrange-dragging";

type ArrangeDndState = { active: ArrangeDragData | null };
const ArrangeDndStateContext = createContext<ArrangeDndState>({ active: null });

export function useArrangeDndState(): ArrangeDndState {
  return useContext(ArrangeDndStateContext);
}

interface ArrangeDndProviderProps {
  roots: InfLocation[];
  moveLocation: (
    dragId: LocationShortcode,
    targetId: LocationShortcode | null,
  ) => void;
  moveItem: (drag: ItemDragData, targetLocationId: LocationShortcode) => void;
  children: ReactNode;
}

/** One dnd-kit boundary for both Arrange views, with live policy revalidation. */
export function ArrangeDndProvider({
  roots,
  moveLocation,
  moveItem,
  children,
}: ArrangeDndProviderProps) {
  const [active, setActive] = useState<ArrangeDragData | null>(null);
  const autoScroller = useRef(createDndAutoScroller()).current;
  const origin = useRef<{ x: number; y: number } | null>(null);
  const keyboardCoordinates = useMemo(
    () =>
      createValidTargetKeyboardCoordinates((activeData, targetData) => {
        const drag = asDragData(activeData);
        const drop = asDropData(targetData);
        return (
          !!drag &&
          !!drop &&
          canDropOnArrangeTarget(roots, drop.locationId, drag)
        );
      }),
    [roots],
  );
  const sensors = useCubbyDndSensors({ keyboardCoordinates });
  // Hydration-stable id; see TableHeaderLayout for why the counter default breaks.
  const describedById = `DndDescribedBy-${useId()}`;
  useEffect(() => {
    document.body.classList.toggle(DRAGGING_CLASS, active !== null);
    return () => document.body.classList.remove(DRAGGING_CLASS);
  }, [active]);
  useEffect(() => () => autoScroller.stop(), [autoScroller]);
  const collisionDetection = useMemo<CollisionDetection>(
    () => (args) => {
      const drag = asDragData(args.active.data.current);
      if (!drag) return [];
      const droppableContainers = args.droppableContainers.filter(
        (container) => {
          const drop = asDropData(container.data.current);
          return !!drop && canDropOnArrangeTarget(roots, drop.locationId, drag);
        },
      );
      const filtered = { ...args, droppableContainers };
      return pointerWithin(filtered).length
        ? pointerWithin(filtered)
        : closestCorners(filtered);
    },
    [roots],
  );
  const onDragStart = ({ active: drag, activatorEvent }: DragStartEvent) => {
    if (activatorEvent instanceof TouchEvent) {
      const touch = activatorEvent.touches[0];
      origin.current = touch ? { x: touch.clientX, y: touch.clientY } : null;
    } else if (activatorEvent instanceof MouseEvent) {
      origin.current = {
        x: activatorEvent.clientX,
        y: activatorEvent.clientY,
      };
    } else {
      origin.current = null;
    }
    setActive(asDragData(drag.data.current));
  };
  const onDragMove = ({ delta }: DragMoveEvent) => {
    if (!origin.current) return;
    autoScroller.update(
      { x: origin.current.x + delta.x, y: origin.current.y + delta.y },
      document.querySelectorAll<HTMLElement>("[data-arrange-scroll]"),
    );
  };
  const onDragEnd = ({ active: dragEvent, over }: DragEndEvent) => {
    const drag = asDragData(dragEvent.data.current);
    const drop = over ? asDropData(over.data.current) : null;
    autoScroller.stop();
    origin.current = null;
    setActive(null);
    if (!drag || !drop || !canDropOnArrangeTarget(roots, drop.locationId, drag))
      return;
    if (drag.arrangeDrag === "location")
      moveLocation(drag.locationId, drop.locationId);
    else if (drop.locationId !== null) moveItem(drag, drop.locationId);
  };
  return (
    <ArrangeDndStateContext.Provider value={{ active }}>
      <DndContext
        id={describedById}
        sensors={sensors}
        autoScroll={false}
        collisionDetection={collisionDetection}
        onDragStart={onDragStart}
        onDragMove={onDragMove}
        onDragCancel={() => {
          origin.current = null;
          autoScroller.stop();
          setActive(null);
        }}
        onDragEnd={onDragEnd}
        accessibility={{
          container: globalThis.document?.body,
          announcements: createDndAnnouncements({
            item: (id) =>
              id
                .replace("arrange-location:", "location ")
                .replace("arrange-item:", "item "),
            target: (id) => id.replace("arrange-target:", "location "),
          }),
          screenReaderInstructions: cubbyDndScreenReaderInstructions,
        }}
      >
        {children}
        <DragOverlay dropAnimation={null}>
          {active ? (
            <DragPreviewFrame className="px-2 py-1 text-sm">
              Moving {active.arrangeDrag === "location" ? "location" : "item"}
            </DragPreviewFrame>
          ) : null}
        </DragOverlay>
      </DndContext>
    </ArrangeDndStateContext.Provider>
  );
}
