import type { ListSlotId } from "@cubby/schemas/entity-manifest";

import type {
  ListSlotComponent,
  ListSlotProps,
} from "~/app/_components/entity-list/list-slot-types";
import { Stack } from "~/components/layout";
import { getEntityFilters } from "~/entities/filter-manifest";
import {
  buildFiltersFromManifest,
  filterGetterFromSearch,
  type FilterSearch,
} from "~/entities/filters";

import { TasksBoardView } from "./board/TasksBoardView";
import { NextTasks } from "./next-tasks";
import { TasksStatsStrip } from "./TasksStatsStrip";

/** The renderers take the manifest filters, read straight from the URL. */
const useRendererFilters = (search: ListSlotProps["search"]) => {
  const specs = getEntityFilters("task");
  // SAFETY: the route validated `search` through the task's generated schema.
  return buildFiltersFromManifest(
    specs,
    filterGetterFromSearch(specs, search as FilterSearch),
  );
};

/** Next is the explicitly labeled actionable-work renderer. */
function TaskAgendaSlot({ search }: ListSlotProps) {
  const filters = useRendererFilters(search);
  return (
    <Stack gap="md">
      <TasksStatsStrip />
      <NextTasks filters={filters} />
    </Stack>
  );
}

function TaskBoardSlot({ search }: ListSlotProps) {
  const filters = useRendererFilters(search);
  return <TasksBoardView filters={filters} />;
}

export const taskListSlots = {
  agenda: TaskAgendaSlot,
  board: TaskBoardSlot,
} satisfies Record<ListSlotId<"task">, ListSlotComponent>;
