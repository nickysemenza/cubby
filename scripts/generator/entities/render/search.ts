import { generatedHeader } from "../../artifacts.ts";
import type {
  CompiledEntity,
  EntityArtifacts,
  FilterDescriptor,
  SourceRef,
} from "../declarations.ts";
import { sourceRefImports } from "./filters.ts";
import { entityProjectionMaps } from "./index.ts";
import { renderRecord } from "./record.ts";

/**
 * The search-param codec for one filter descriptor. Every codec is built on
 * `urlStringParam` (never a bare `z.string()`): the router JSON-parses each
 * param first, so `?q=486242` arrives as a number and `?future=true` as a
 * boolean, and a plain string schema would drop both silently.
 */
const searchCodec = (
  descriptor: FilterDescriptor,
  alias: (ref: SourceRef) => string,
): string => {
  switch (descriptor.kind) {
    case "id":
      return descriptor.brandRef === null
        ? "urlStringParam"
        : `urlShortcodeParam(${JSON.stringify(descriptor.brandRef.entity)})`;
    case "idMulti":
      return descriptor.brandRef === null
        ? "urlStringParam"
        : `urlShortcodeListParam(${JSON.stringify(descriptor.brandRef.entity)}${descriptor.nullable === null ? "" : ", { sentinels: PRESENCE_SENTINELS }"})`;
    case "select":
    case "multiselect": {
      const values =
        descriptor.schemaRef !== null
          ? alias(descriptor.schemaRef)
          : descriptor.options !== null
            ? `z.enum(${JSON.stringify(descriptor.options.map(({ value }) => value))})`
            : null;
      // Options resolved at runtime (`optionsKey` / `optionsRef`) have no
      // static roster to validate against.
      if (values === null) return "urlStringParam";
      return `urlEnumListParam(${descriptor.nullable === null ? values : `withPresenceSentinels(${values})`})`;
    }
    default:
      return "urlStringParam";
  }
};

/**
 * `entity-search.gen.ts`: one `{ schema, defaults }` per entity. `schema` is
 * the list route's `validateSearch` (manifest filter keys, the shared table
 * keys, and `create` for a dialog-created entity); `defaults` names every
 * key, because `stripSearchParams(defaults)` strips only the keys it is
 * given. Hand-written routes compose route-only keys on top of `schema.shape`.
 */
export const renderSearchArtifacts = (
  entities: readonly CompiledEntity[],
): EntityArtifacts[] => {
  const { filters: filterEntities } = entityProjectionMaps(entities);
  const { imports, alias } = sourceRefImports(
    filterEntities.flatMap(({ filterDescriptors }) =>
      filterDescriptors.flatMap(({ kind, schemaRef }) =>
        (kind === "select" || kind === "multiselect") && schemaRef !== null
          ? [schemaRef]
          : [],
      ),
    ),
    "searchRef",
  );
  const tableKeys = ["sort", "page", "pageSize", "worklist"];
  const entries = filterEntities
    .map((entity) => {
      const fields = entity.filterDescriptors.map(
        (descriptor) =>
          `${JSON.stringify(descriptor.urlKey)}:${searchCodec(descriptor, alias)},`,
      );
      const dialog = entity.route?.create === "dialog";
      const keys = [
        ...entity.filterDescriptors.map(({ urlKey }) => urlKey),
        ...tableKeys,
        ...(dialog ? ["create"] : []),
      ];
      return (
        `${JSON.stringify(entity.key)}:{\n` +
        `schema:z.object({\n${fields.join("\n")}\n...tableSearchFields,\n${dialog ? "create:createSearchField,\n" : ""}}),\n` +
        `defaults:{${keys.map((key) => `${JSON.stringify(key)}:undefined`).join(",")}},\n},`
      );
    })
    .join("\n");
  return [
    {
      relativePath: "apps/web/src/entities/generated/entity-search.gen.ts",
      source:
        generatedHeader +
        'import type { Entity } from "@cubby/schemas/entity";\n' +
        `${imports}\n` +
        'import { z } from "zod";\n\n' +
        'import { tableSearchFields } from "~/app/_components/data-table/table-search";\n' +
        'import { FILTER_ANY, FILTER_NONE } from "~/entities/filters";\n' +
        'import { urlEnumListParam, urlShortcodeListParam, urlShortcodeParam, urlStringParam } from "~/lib/search-params";\n\n' +
        renderRecord({
          name: "entityFilterUrlKeyRoster",
          entries: Object.fromEntries(
            filterEntities.map(({ key, filterUrlKeys }) => [
              key,
              filterUrlKeys,
            ]),
          ),
          satisfies: "Record<Entity, readonly string[]>",
          comment: "// Generated data stays one entity per line.",
          exported: false,
        }) +
        "\n" +
        "/** The URL keys an entity accepts for its canonical filter assembly. */\n" +
        "export const entityFilterUrlKeys = (entity: Entity): readonly string[] =>\n" +
        "  entityFilterUrlKeyRoster[entity] ?? [];\n\n" +
        "// A nullable filter also accepts the presence sentinels the filter UI writes.\n" +
        "const PRESENCE_SENTINELS = [FILTER_ANY, FILTER_NONE] as const;\n" +
        "const withPresenceSentinels = <T extends z.ZodType<string>>(schema: T) =>\n" +
        "  z.union([schema, z.literal(FILTER_ANY), z.literal(FILTER_NONE)]);\n" +
        "// `?create=true` opens the capture dialog; a real boolean, not a string.\n" +
        "const createSearchField = z.boolean().optional().catch(undefined);\n\n" +
        `export const entitySearch = {\n${entries}\n};\n`,
    },
  ];
};
