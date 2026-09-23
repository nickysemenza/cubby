import type { ListSlotId } from "@cubby/schemas/entity-manifest";

import type { ListSlotComponent } from "~/app/_components/entity-list/list-slot-types";

import { ProjectScheduleListSlot } from "./project-schedule";
import { ProjectsDashboard } from "./projects-dashboard";

const ProjectOverviewSlot: ListSlotComponent = () => (
  <ProjectsDashboard view="overview" />
);
const ProjectAnalyticsSlot: ListSlotComponent = () => (
  <ProjectsDashboard view="analytics" />
);
export const projectListSlots = {
  overview: ProjectOverviewSlot,
  schedule: ProjectScheduleListSlot,
  analytics: ProjectAnalyticsSlot,
} satisfies Record<ListSlotId<"project">, ListSlotComponent>;
