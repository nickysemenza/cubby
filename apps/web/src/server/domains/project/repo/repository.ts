import { projectSchemaBindings } from "~/entity/generated/entity-schema-bindings.project.gen";
import { DECLARED_EDGE_DELETE_POLICIES } from "~/server/db/generated/declared-edges.gen";
import {
  asActor,
  defineRepository,
} from "~/server/entity-kernel/repo/repository";

import { createProject, deleteProjects, updateProject } from "./crud";
import { projectScaffold } from "./lookup";

export const projectRepository = defineRepository("project", {
  schemas: projectSchemaBindings,
  lifecycle: { delete: DECLARED_EDGE_DELETE_POLICIES.project },
  scaffold: projectScaffold,
  create: asActor(createProject),
  update: asActor(updateProject),
  delete: asActor(deleteProjects),
});
