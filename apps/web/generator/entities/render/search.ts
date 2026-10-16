import {
  isSlotListView,
  listViewId,
} from "../../../../../packages/schemas/src/entity-definitions/definition.ts";
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
import { resolvedPrimarySearch } from "./shared.ts";

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
  // The non-value items the filter UI writes into this key's list: Any /
  // No value, Match all, `@me` (resolved server-side) and declared sentinels.
  const tokens = [
    ...(descriptor.nullable === null ? [] : ["FILTER_ANY", "FILTER_NONE"]),
    ...(descriptor.match === null ? [] : ["FILTER_ALL"]),
    ...(descriptor.currentMember ? ["CURRENT_MEMBER_FILTER"] : []),
    ...(descriptor.sentinels ?? []).map(({ value }) => JSON.stringify(value)),
  ];
  switch (descriptor.kind) {
    case "idMulti": {
      if (descriptor.brandRef === null) return "urlStringParam";
      return `urlShortcodeListParam(${JSON.stringify(descriptor.brandRef.entity)}${tokens.length === 0 ? "" : `, { sentinels: [${tokens.join(", ")}] }`})`;
    }
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
      return `urlEnumListParam(${tokens.length === 0 ? values : `withTokens(${values}, [${tokens.join(", ")}])`})`;
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
        kind === "multiselect" && schemaRef !== null ? [schemaRef] : [],
      ),
    ),
    "searchRef",
  );
  const tableKeys = ["sort", "page", "pageSize", "worklist", "filters"];
  const timelineKeys = [
    "timelineFrom",
    "timelineTo",
    "timelineOrder",
    "timelineMode",
  ];
  const entries = filterEntities
    .map((entity) => {
      const primarySearch = resolvedPrimarySearch(entity);
      const filterDescriptors = entity.filterDescriptors.filter(
        (descriptor) => descriptor.urlKey !== primarySearch?.key,
      );
      const fields = [
        ...(primarySearch
          ? [`${JSON.stringify(primarySearch.key)}:urlStringParam,`]
          : []),
        ...filterDescriptors.map(
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
      const viewAliases = Object.keys(entity.inspector.list.viewAliases);
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
          ? `view:z.enum(${JSON.stringify([...viewIds, ...viewAliases])}).optional().catch(undefined),\n`
          : "";
      const slotFields = slotKeys
        .map((key) => `${JSON.stringify(key)}:urlStringParam,`)
        .join("\n");
      const timelineFields = timeline
        ? 'timelineFrom:urlPlainDateParam,\ntimelineTo:urlPlainDateParam,\ntimelineOrder:z.enum(["asc","desc"]).optional().catch(undefined),\ntimelineMode:z.enum(["events","lifecycles"]).optional().catch(undefined),\n'
        : "";
      // The nested/flat switch and the Group by choice are URL state, so a
      // reload or shared link keeps the presentation; absent is the default.
      const nestToggle = entity.inspector.list.tree?.toggle === true;
      const groupKeys = entity.listFields.grouping
        .filter(({ reason }) => reason === null)
        .map(({ key }) => key);
      const grouped = groupKeys.length > 0;
      const presentationFields = [
        ...(nestToggle
          ? ['nest:z.enum(["on","off"]).optional().catch(undefined),']
          : []),
        ...(grouped
          ? [
              `groupBy:z.enum(${JSON.stringify(groupKeys)}).optional().catch(undefined),`,
            ]
          : []),
      ].join("\n");
      const keys = [
        ...(primarySearch ? [primarySearch.key] : []),
        ...filterDescriptors.map(({ urlKey }) => urlKey),
        ...tableKeys,
        ...(dialog ? ["create"] : []),
        ...(viewIds.length > 1 ? ["view"] : []),
        ...slotKeys,
        ...(timeline ? timelineKeys : []),
        ...(nestToggle ? ["nest"] : []),
        ...(grouped ? ["groupBy"] : []),
      ];
      if (new Set(keys).size !== keys.length)
        throw new EntityDeclarationError(
          `${entity.key} list search keys collide: ${keys.filter((key, index) => keys.indexOf(key) !== index).join(", ")}.`,
        );
      return (
        `${JSON.stringify(entity.key)}:{\n` +
        `schema:z.object({\n${fields.join("\n")}\n...tableSearchFields,\n${dialog ? "create:createSearchField,\n" : ""}${viewField}${slotFields}${slotFields ? "\n" : ""}${timelineFields}${presentationFields}${presentationFields ? "\n" : ""}}),\n` +
        `defaults:{${keys.map((key) => `${JSON.stringify(key)}:undefined`).join(",")}},\n},`
      );
    })
    .join("\n");
  const tokenImports = ["FILTER_ALL", "FILTER_ANY", "FILTER_NONE"]
    .filter((token) => entries.includes(token))
    .join(", ");
  return [
    {
      relativePath: "apps/web/src/entity/generated/entity-search.gen.ts",
      source:
        generatedHeader +
        'import type { Entity } from "@cubby/schemas/entity";\n' +
        'import { CURRENT_MEMBER_FILTER } from "@cubby/shared";\n' +
        `${imports}\n` +
        'import { z } from "zod";\n\n' +
        'import { tableSearchFields } from "~/ui/data-table/table-search";\n' +
        `import { ${tokenImports} } from "~/entity/filters";\n` +
        'import { urlEnumListParam, urlPlainDateParam, urlShortcodeListParam, urlStringParam } from "~/lib/search-params";\n\n' +
        renderRecord({
          name: "entityFilterUrlKeyRoster",
          entries: Object.fromEntries(
            filterEntities.map((entity) => {
              const primarySearch = resolvedPrimarySearch(entity);
              return [
                entity.key,
                primarySearch === null
                  ? entity.filterUrlKeys
                  : [...new Set([primarySearch.key, ...entity.filterUrlKeys])],
              ];
            }),
          ),
          satisfies: "Record<Entity, readonly string[]>",
          comment: "// Generated data stays one entity per line.",
          exported: false,
        }) +
        "\n" +
        "/** The URL keys an entity accepts for its canonical filter assembly. */\n" +
        "export const entityFilterUrlKeys = (entity: Entity): readonly string[] =>\n" +
        "  entityFilterUrlKeyRoster[entity] ?? [];\n\n" +
        "// A filter list also accepts the tokens the filter UI writes into it.\n" +
        "const withTokens = <T extends z.ZodType<string>>(\n" +
        "  schema: T,\n" +
        "  tokens: readonly [string, ...string[]],\n" +
        ") => z.union([schema, z.enum(tokens)]);\n" +
        "// `?create=true` opens the capture dialog; a real boolean, not a string.\n" +
        "const createSearchField = z.boolean().optional().catch(undefined);\n\n" +
        `export const entitySearch = {\n${entries}\n};\n`,
    },
  ];
};
