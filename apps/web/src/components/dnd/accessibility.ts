import type { Announcements, ScreenReaderInstructions } from "@dnd-kit/core";

interface DndAnnouncementLabels {
  item(activeId: string): string;
  target?(overId: string): string;
  pickedUp?: string;
  moved?: string;
  dropped?: string;
  cancelled?: string;
}

/** Build consistent, surface-specific live-region copy without sharing policy. */
export function createDndAnnouncements({
  item,
  target = (id) => id,
  pickedUp = "Picked up",
  moved = "Move target",
  dropped = "Dropped",
  cancelled = "Drag cancelled",
}: DndAnnouncementLabels): Announcements {
  return {
    onDragStart({ active }) {
      return `${pickedUp}: ${item(String(active.id))}.`;
    },
    onDragOver({ active, over }) {
      if (!over)
        return `${item(String(active.id))} is not over a valid target.`;
      return `${moved}: ${target(String(over.id))}.`;
    },
    onDragEnd({ active, over }) {
      if (!over) return `${item(String(active.id))} was not moved.`;
      return `${dropped}: ${item(String(active.id))}, ${target(String(over.id))}.`;
    },
    onDragCancel({ active }) {
      return `${cancelled}: ${item(String(active.id))}.`;
    },
  };
}

export const cubbyDndScreenReaderInstructions: ScreenReaderInstructions = {
  draggable:
    "Press space or enter to pick up. Use the arrow keys to move. Press space or enter to drop, or escape to cancel.",
};
