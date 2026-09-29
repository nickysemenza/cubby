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
import { projectList } from "./lookup";

export const projectRepository = defineRepository("project", {
  lifecycle: { delete: PROJECT_DELETE_EDGE_POLICY },
  get: onDb(getProjectByShortcode),
  list: listOn(projectList),
  create: asActor(createProject),
  update: asActor(updateProject),
  delete: asActor(deleteProjects),
});
