import { tsModule, tsReference } from "../../artifacts.ts";
import type { CompiledEntity, EntityArtifacts } from "../declarations.ts";
import { entityProjectionMaps } from "./capabilities.ts";
import { renderBrowserReadContracts } from "./browser-read-contracts.ts";

export const renderEntityReadArtifacts = (
  entities: readonly CompiledEntity[],
): EntityArtifacts[] => {
  const projections = entityProjectionMaps(entities);
  const reads = entities.filter(
    ({ key }) =>
      projections.detail.some((entity) => entity.key === key) ||
      projections.list.some((entity) => entity.key === key),
  );
  const data = reads.map((entity): EntityArtifacts => {
    const name = entity.key.replaceAll(/-([a-z])/gu, (_, letter: string) =>
      letter.toUpperCase(),
    );
    const filter = entity.filterSchema;
    return {
      relativePath: `apps/web/src/entity/generated/entity-read-data.${entity.key}.gen.ts`,
      source: tsModule({
        imports: [
          {
            from: `@cubby/schemas/compiler/generated/entity-field-envelopes/${entity.key}`,
            names: [`${name}FieldEnvelopeSchemas as envelopes`],
          },
          ...(filter
            ? [
                {
                  from: filter.module,
                  names: [`${filter.export} as filterFields`],
                },
              ]
            : []),
        ],
        consts: [
          {
            name: "definition",
            value: {
              entity: entity.key,
              envelopes: tsReference("envelopes"),
              filterFields: filter ? tsReference("filterFields") : null,
              searchable: entity.descriptor.searchable === true,
              tree: entity.inspector.list.tree !== null,
            },
          },
        ],
      }),
    };
  });
  return [
    ...data,
    ...renderBrowserReadContracts(entities),
    {
      relativePath: "apps/web/src/entity/generated/entity-read-data.gen.ts",
      source: tsModule({
        imports: reads.map(({ key }, index) => ({
          from: `./entity-read-data.${key}.gen`,
          names: [`definition as definition${index}`],
        })),
        consts: [
          {
            name: "readDefinitions",
            value: Object.fromEntries(
              reads.map(({ key }, index) => [
                key,
                tsReference(`definition${index}`),
              ]),
            ),
          },
        ],
      }),
    },
    {
      relativePath:
        "apps/web/src/server/generated/entity-details.server.gen.ts",
      source: tsModule({
        exports: [
          {
            from: "../entity-reads/detail-contracts",
            names: ["detailEntities", "getEntityDetailOutputSchema"],
          },
        ],
      }),
    },
    {
      relativePath: "apps/web/src/server/generated/entity-lists.server.gen.ts",
      source: tsModule({
        exports: [
          {
            from: "../entity-reads/list-contracts",
            names: [
              "listEntities",
              "entityListInputSchema",
              "ENTITY_LIST_READ_SCHEMAS",
              "getEntityListOutputSchema",
            ],
          },
          {
            from: "../entity-reads/list-contracts",
            typeOnly: true,
            names: ["ListEntity", "EntityListResultByEntity"],
          },
        ],
      }),
    },
  ];
};
