import {
  asActor,
  defineRepository,
} from "~/server/entity-kernel/repo/repository";

import {
  createProject,
  deleteProjects,
  PROJECT_DELETE_EDGE_POLICY,
  updateProject,
} from "./crud";
import { projectScaffold } from "./lookup";

export const projectRepository = defineRepository("project", {
  lifecycle: { delete: PROJECT_DELETE_EDGE_POLICY },
  scaffold: projectScaffold,
  create: asActor(createProject),
  update: asActor(updateProject),
  delete: asActor(deleteProjects),
});
