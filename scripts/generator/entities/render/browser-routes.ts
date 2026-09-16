import { generatedHeader } from "../../artifacts.ts";
import {
  EntityDeclarationError,
  type CompiledEntity,
  type EntityArtifacts,
  type SourceRef,
} from "../declarations.ts";
import { entityProjectionMaps } from "./index.ts";
import { browserRoutes } from "./routes.ts";

const pascalCase = (value: string) =>
  value
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part.length > 0)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join("");

const importLine = (ref: SourceRef) =>
  `import { ${ref.export} } from ${JSON.stringify(ref.module)};`;

// The router plugin's splitter re-parses an inlined call expression with a
// JSX-less babel config, so page bodies are bound to consts and only the
// identifier reaches the literal options object (see `entity-routes.tsx`).
const splitterNote =
  "// Bound to a const, not inlined into the options object: the router plugin's\n" +
  "// splitter re-parses an inlined call expression with a JSX-less babel config,\n" +
  "// so only the identifier path survives a page body that renders JSX.\n";

type RoutedEntity = CompiledEntity & {
  route: NonNullable<CompiledEntity["route"]>;
};

const renderIndexRoute = (
  entity: RoutedEntity,
  list: NonNullable<RoutedEntity["route"]["list"]>,
  withLoader: boolean,
): string => {
  const { basePath } = browserRoutes(entity);
  const page = `${pascalCase(basePath)}Page`;
  const plural = entity.inspector.plural ?? entity.inspector.singular;
  const dialog = entity.route.create === "dialog";
  const actions =
    list.actions === null
      ? null
      : list.actions === undefined
        ? dialog
          ? `<CreateDialogAction request={captureRequest(${JSON.stringify(entity.key)})}>New ${entity.inspector.singular}</CreateDialogAction>`
          : null
        : `<${list.actions.export} />`;
  const imports = [
    'import { createFileRoute, stripSearchParams } from "@tanstack/react-router";',
    "",
    ...(actions !== null && list.actions === undefined
      ? [
          'import { CreateDialogAction } from "~/app/_components/forms/create-dialog-action";',
        ]
      : []),
    'import { listPage } from "~/app/_components/routing/entity-routes";',
    importLine(list.component),
    ...(list.actions ? [importLine(list.actions)] : []),
    ...(actions !== null && list.actions === undefined
      ? ['import { captureRequest } from "~/entities/editing/editor-requests";']
      : []),
    ...(withLoader
      ? ['import { entityListLoader } from "~/entities/entity-list-ssr";']
      : []),
    'import { entitySearch } from "~/entities/generated/entity-search.gen";',
    'import { pageTitle } from "~/lib/page-title";',
  ];
  return (
    generatedHeader +
    `${imports.join("\n")}\n\n` +
    splitterNote +
    `const ${page} = listPage({\n` +
    `  title: ${JSON.stringify(plural)},\n` +
    `  entity: ${JSON.stringify(entity.key)},\n` +
    `  list: ${list.component.export},\n` +
    (actions === null ? "" : `  actions: () => ${actions},\n`) +
    "});\n\n" +
    `export const Route = createFileRoute(${JSON.stringify(`/_authenticated/${basePath}/`)})({\n` +
    `  validateSearch: entitySearch.${entity.key}.schema,\n` +
    `  search: { middlewares: [stripSearchParams(entitySearch.${entity.key}.defaults)] },\n` +
    (withLoader
      ? "  loaderDeps: ({ search }) => search,\n" +
        `  loader: entityListLoader(${JSON.stringify(entity.key)}),\n`
      : "") +
    `  head: () => ({ meta: [{ title: pageTitle(${JSON.stringify(plural)}) }] }),\n` +
    `  component: ${page},\n` +
    "});\n"
  );
};

const renderDetailRoute = (
  entity: RoutedEntity,
  detail: NonNullable<RoutedEntity["route"]["detail"]>,
  kernelDetail: boolean,
): string => {
  const { basePath, detailParam } = browserRoutes(entity);
  const name = pascalCase(basePath);
  if (!kernelDetail && detail.query === undefined) {
    throw new EntityDeclarationError(
      `${entity.key}.route.detail needs a query: the entity is outside the kernel detail roster.`,
    );
  }
  const query = (shortcode: string) =>
    detail.query === undefined
      ? `entityDetailFor(${JSON.stringify(entity.key)}).queryOptions(${shortcode})`
      : `${detail.query.export}(${shortcode})`;
  const imports = [
    'import { createFileRoute } from "@tanstack/react-router";',
    "",
    'import { ensureDetailRecord } from "~/app/_components/routing/detail-loader";',
    'import { detailPage, notFoundPage } from "~/app/_components/routing/entity-routes";',
    importLine(detail.component),
    'import { RouteErrorComponent } from "~/components/lazy-route-error";',
    'import { DetailPagePending } from "~/components/route-pending";',
    detail.query === undefined
      ? 'import { entityDetailFor } from "~/entities/entity-detail.functions";'
      : importLine(detail.query),
    'import { shortcodeHead } from "~/lib/page-title";',
  ];
  return (
    generatedHeader +
    `${imports.join("\n")}\n\n` +
    splitterNote +
    `const ${name}DetailPage = detailPage({\n` +
    `  query: (${detailParam}) => ${query(detailParam)},\n` +
    `  render: (record, ${detailParam}) => <${detail.component.export} key={${detailParam}} record={record} />,\n` +
    `  title: (record) => record.${entity.inspector.titleField},\n` +
    "});\n\n" +
    `const ${name}NotFound = notFoundPage(${JSON.stringify(entity.key)});\n\n` +
    `export const Route = createFileRoute(${JSON.stringify(`/_authenticated/${basePath}/$${detailParam}`)})({\n` +
    "  loader: ({ params, context }) =>\n" +
    `    ensureDetailRecord(context.queryClient, ${query(`params.${detailParam}`)}),\n` +
    "  pendingComponent: DetailPagePending,\n" +
    "  errorComponent: RouteErrorComponent,\n" +
    `  notFoundComponent: ${name}NotFound,\n` +
    "  head: shortcodeHead,\n" +
    `  component: ${name}DetailPage,\n` +
    "});\n"
  );
};

/**
 * The boilerplate list and detail route modules, one per `route.list` /
 * `route.detail` declaration. They live beside the hand-written routes
 * (TanStack's file router needs physical files, and a `__virtual.ts` would
 * take over the whole directory), carrying the generated header so the
 * staleness and extraneous-file checks cover them.
 */
export const renderBrowserRouteArtifacts = (
  entities: readonly CompiledEntity[],
): EntityArtifacts[] => {
  const projections = entityProjectionMaps(entities);
  const listEntities = new Set(projections.list.map(({ key }) => key));
  const detailEntities = new Set(projections.detail.map(({ key }) => key));
  return entities
    .filter(
      (entity): entity is RoutedEntity =>
        entity.route !== null && entity.descriptor.browserRoutes !== false,
    )
    .flatMap((entity) => {
      const { basePath, detailParam } = browserRoutes(entity);
      const directory = "apps/web/src/routes/_authenticated";
      return [
        ...(entity.route.list === null
          ? []
          : [
              {
                relativePath: `${directory}/${basePath}.index.tsx`,
                source: renderIndexRoute(
                  entity,
                  entity.route.list,
                  listEntities.has(entity.key),
                ),
              },
            ]),
        ...(entity.route.detail === null
          ? []
          : [
              {
                relativePath: `${directory}/${basePath}.$${detailParam}.tsx`,
                source: renderDetailRoute(
                  entity,
                  entity.route.detail,
                  detailEntities.has(entity.key),
                ),
              },
            ]),
      ];
    });
};
