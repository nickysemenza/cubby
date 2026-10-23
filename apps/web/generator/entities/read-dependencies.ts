import type { CompiledEntity } from "./declarations.ts";

/** Explicit read paths name their inputs; this never discovers or schedules work. */
export const entityReadDependents = (entities: readonly CompiledEntity[]) => {
  const byTable = new Map(
    entities.flatMap((entity) =>
      typeof entity.descriptor.dbTable === "string"
        ? [[entity.descriptor.dbTable, entity.key] as const]
        : [],
    ),
  );
  const dependents = new Map(
    entities.map(({ key }) => [key, new Set<string>()]),
  );
  for (const consumer of entities) {
    const inputs = new Set(
      consumer.fieldModel.fields.flatMap((field) =>
        field.readKey !== null &&
        field.reference !== null &&
        (field.display.labelPath !== null ||
          field.display.detailLabelPath != null)
          ? [field.reference.entity]
          : [],
      ),
    );
    for (const field of Object.values(consumer.listFields.derived)) {
      if (field.shape !== "via") continue;
      inputs.add(field.target);
      for (const step of field.steps) {
        const table = step.edge.split(".")[0];
        const input = table === undefined ? undefined : byTable.get(table);
        if (input !== undefined) inputs.add(input);
      }
    }
    for (const source of consumer.imagePolicy.displaySources) {
      let current = consumer;
      for (const key of source.relationPath) {
        const relation = current.relations.find(
          (relation) => relation.key === key,
        );
        const target = entities.find(
          (entity) => entity.key === relation?.target,
        );
        if (!target) break;
        inputs.add(target.key);
        current = target;
      }
    }
    for (const input of inputs)
      if (input !== consumer.key) dependents.get(input)?.add(consumer.key);
  }
  return Object.fromEntries(
    [...dependents].map(([key, consumers]) => [key, [...consumers].sort()]),
  );
};
