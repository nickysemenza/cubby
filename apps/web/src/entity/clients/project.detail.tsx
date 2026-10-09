import {
  ProjectAnalytics,
  ProjectBudget,
  ProjectContribution,
  ProjectSchedule,
} from "~/app/projects/slots";
import { defineDetailHooks } from "~/entity/entity-detail/detail-hooks";

export const projectDetailHooks = defineDetailHooks("project", {
  slots: {
    schedule: { component: ProjectSchedule },
    budget: { component: ProjectBudget },
    contribution: { component: ProjectContribution },
    analytics: { component: ProjectAnalytics },
  },
});
