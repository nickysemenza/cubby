import {
  asActor,
  defineRepository,
  listOn,
  onDb,
} from "~/server/repo/repository";

import {
  createProject,
  deleteProjects,
  getProjectByShortcode,
  PROJECT_DELETE_EDGE_POLICY,
  updateProject,
} from "./crud";
import { projectList, projectListRead, projectListSummary } from "./lookup";

export const projectRepository = defineRepository("project", {
  lifecycle: { delete: PROJECT_DELETE_EDGE_POLICY },
  get: onDb(getProjectByShortcode),
  list: listOn(projectList),
  listRead: (ctx, filters, sorts, pagination, projection) =>
    projectListRead(ctx.db, filters, sorts, pagination, projection),
  listSummary: (ctx, filters) => projectListSummary(ctx.db, filters),
  create: asActor(createProject),
  update: asActor(updateProject),
  delete: asActor(deleteProjects),
});
