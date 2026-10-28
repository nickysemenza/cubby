import type { EntityDeclarationMetadata } from "@cubby/schemas/entity-definitions/definition";

/** Generated contract names are shared by source-default resolution and the emitters. */
export const entityContractName = (key: string): string =>
  key.replaceAll(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
const entityContractModule = (key: string): string =>
  `@cubby/schemas/entity-contracts/${key}`;

/** Explicit null disables a contract; omitted ordinary contracts come from field-owned schemas. */
export const resolveDefaultContracts = (
  declaration: EntityDeclarationMetadata,
) => {
  const name = entityContractName(declaration.key);
  const ref = (suffix: string) => ({
    module: entityContractModule(declaration.key),
    export: `${name}${suffix}`,
  });
  const ordinary =
    declaration.table !== null && declaration.identifiers.shortcode !== null;
  const overrides = declaration.fields;
  const fields =
    overrides === null || (overrides === undefined && !ordinary)
      ? null
      : {
          ...overrides,
          create:
            overrides?.create === undefined
              ? declaration.model?.create.length
                ? ref("CreateInput")
                : null
              : overrides.create,
          update:
            overrides?.update === undefined
              ? declaration.model?.update.length
                ? ref("UpdateData")
                : null
              : overrides.update,
          output: overrides?.output ?? ref("RawOut"),
          list: overrides?.list ?? ref("RawListItemOut"),
          detail: overrides?.detail ?? ref("RawDetailOut"),
        };
  const model = declaration.model;
  // Ordinary editors use the same field eligibility as the writers. Domain
  // repositories keep their authored workflow intents and their ordering.
  const defaultIntents: NonNullable<
    EntityDeclarationMetadata["model"]
  >["intents"] =
    ordinary &&
    declaration.extensions.ports.repository === null &&
    model &&
    (fields?.create || fields?.update)
      ? {
          fields: {
            ...(fields.create ? { create: model.create } : {}),
            ...(fields.update ? { full: model.update } : {}),
          },
          create: fields.create ? ["create"] : [],
          update: fields.update ? ["full"] : [],
          editorFields: [],
          required: {},
        }
      : undefined;
  return {
    ...declaration,
    model: model
      ? { ...model, intents: model.intents ?? defaultIntents }
      : undefined,
    fields,
    filters: {
      ...declaration.filters,
      schema:
        declaration.filters.schema === undefined
          ? fields === null
            ? null
            : ref("FilterFields")
          : declaration.filters.schema,
    },
  };
};
