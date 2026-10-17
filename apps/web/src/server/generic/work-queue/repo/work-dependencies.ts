import type { Entity } from "@cubby/schemas/entity";

/** Dependency selection is a wake hint; each adapter rechecks its own evidence. */
export const workDependencies = {
  vendorHistory: ["vendor"] satisfies Entity[],
};

export const changesWorkPrerequisite = (entity: Entity) =>
  Object.values(workDependencies).some((dependencies) =>
    dependencies.some((prerequisite) => prerequisite === entity),
  );
