import {
  isSlotListView,
  listViewId,
} from "../../../../packages/schemas/src/entity-definitions/definition.ts";
import { generatedHeader } from "../../artifacts.ts";
import {
  type CompiledEntity,
  type EntityArtifacts,
  EntityDeclarationError,
  type FilterDescriptor,
  type SourceRef,
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
  const timelineKeys = [
    "timelineFrom",
    "timelineTo",
    "timelineOrder",
    "timelineMode",
  ];
  const entries = filterEntities
    .map((entity) => {
      const primarySearch =
        entity.contract !== null && entity.descriptor.searchable === true;
      const fields = [
        ...(primarySearch ? ['"searchQuery":urlStringParam,'] : []),
        ...entity.filterDescriptors.map(
          (descriptor) =>
            `${JSON.stringify(descriptor.urlKey)}:${searchCodec(descriptor, alias)},`,
        ),
      ];
      const dialog = entity.route?.create === "dialog";
      // Declared list views: `view` is an enum over their ids when there is
      // more than one (the first is the default, so it is never written);
      // a slot view's route-only keys ride along as plain strings; a
      // timeline view (list or detail) reads the shared timeline window.
      const views = entity.inspector.list.views;
      const viewIds = views.map(listViewId);
      // Two slot views may share a key (a calendar and its nutrition view
      // both read `date`); one key is emitted once.
      const slotKeys = [
        ...new Set(
          views.flatMap((view) =>
            isSlotListView(view) ? view.searchKeys : [],
          ),
        ),
      ];
      const timeline =
        entity.timeline !== null &&
        (views.includes("timeline") ||
          entity.inspector.detail.sections.some(
            (section) => section.kind === "timeline",
          ));
      const viewField =
        viewIds.length > 1
          ? `view:z.enum(${JSON.stringify(viewIds)}).optional().catch(undefined),\n`
          : "";
      const slotFields = slotKeys
        .map((key) => `${JSON.stringify(key)}:urlStringParam,`)
        .join("\n");
      const timelineFields = timeline
        ? 'timelineFrom:urlPlainDateParam,\ntimelineTo:urlPlainDateParam,\ntimelineOrder:z.enum(["asc","desc"]).optional().catch(undefined),\ntimelineMode:z.enum(["events","lifecycles"]).optional().catch(undefined),\n'
        : "";
      const keys = [
        ...(primarySearch ? ["searchQuery"] : []),
        ...entity.filterDescriptors.map(({ urlKey }) => urlKey),
        ...tableKeys,
        ...(dialog ? ["create"] : []),
        ...(viewIds.length > 1 ? ["view"] : []),
        ...slotKeys,
        ...(timeline ? timelineKeys : []),
      ];
      if (new Set(keys).size !== keys.length)
        throw new EntityDeclarationError(
          `${entity.key} list search keys collide: ${keys.filter((key, index) => keys.indexOf(key) !== index).join(", ")}.`,
        );
      return (
        `${JSON.stringify(entity.key)}:{\n` +
        `schema:z.object({\n${fields.join("\n")}\n...tableSearchFields,\n${dialog ? "create:createSearchField,\n" : ""}${viewField}${slotFields}${slotFields ? "\n" : ""}${timelineFields}}),\n` +
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
        'import { urlEnumListParam, urlPlainDateParam, urlShortcodeListParam, urlShortcodeParam, urlStringParam } from "~/lib/search-params";\n\n' +
        renderRecord({
          name: "entityFilterUrlKeyRoster",
          entries: Object.fromEntries(
            filterEntities.map(
              ({ key, filterUrlKeys, contract, descriptor }) => [
                key,
                contract !== null && descriptor.searchable === true
                  ? ["searchQuery", ...filterUrlKeys]
                  : filterUrlKeys,
              ],
            ),
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
