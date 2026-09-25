import { generatedHeader, yamlGeneratedHeader } from "../../artifacts.ts";
import type {
  CompiledEntity,
  EntityArtifacts,
  SourceRef,
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

const GENERIC_DETAIL = {
  module: "~/app/_components/entity-detail/generic-entity-detail",
  export: "GenericEntityDetail",
} as const satisfies SourceRef;

const renderIndexRoute = (entity: RoutedEntity, listed: boolean): string => {
  const { basePath } = browserRoutes(entity);
  const page = `${pascalCase(basePath)}Page`;
  const plural = entity.inspector.plural ?? entity.inspector.singular;
  // `create: "dialog"` renders the capture trigger (it is also what makes
  // `?create=true` addressable); `create: "page"` links the hand-written
  // `/new` route. Every other header affordance comes from the manifest's
  // `list.actions` / `list.links` through the generic list page.
  const createAction =
    entity.route.create === "dialog"
      ? `<CreateDialogAction request={captureRequest(${JSON.stringify(entity.key)})} />`
      : entity.route.create === "page"
        ? `<Button render={<Link to=${JSON.stringify(`/${basePath}/new`)} />} nativeButton={false}><PlusIcon />New</Button>`
        : null;
  const imports = [
    ...(entity.route.create === "page"
      ? [
          'import { createFileRoute, Link, stripSearchParams } from "@tanstack/react-router";',
          'import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";',
        ]
      : [
          'import { createFileRoute, stripSearchParams } from "@tanstack/react-router";',
        ]),
    "",
    ...(entity.route.create === "dialog"
      ? [
          'import { CreateDialogAction } from "~/app/_components/forms/create-dialog-action";',
        ]
      : []),
    'import { listPage } from "~/app/_components/routing/entity-routes";',
    ...(entity.route.create === "page"
      ? ['import { Button } from "~/components/ui/button";']
      : []),
    ...(entity.route.create === "dialog"
      ? ['import { captureRequest } from "~/entities/editing/editor-requests";']
      : []),
    ...(listed
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
    `  entity: ${JSON.stringify(entity.key)},\n` +
    (createAction === null ? "" : `  actions: () => ${createAction},\n`) +
    "});\n\n" +
    `export const Route = createFileRoute(${JSON.stringify(`/_authenticated/${basePath}/`)})({\n` +
    `  validateSearch: entitySearch.${entity.key}.schema,\n` +
    `  search: { middlewares: [stripSearchParams(entitySearch.${entity.key}.defaults)] },\n` +
    // The eager first-page loader exists only for an entity with a generated
    // list read; a client-paged roster (cookbook) fetches on mount.
    (listed
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
): string => {
  const { basePath, detailParam } = browserRoutes(entity);
  const name = pascalCase(basePath);
  const queryRef = detail === true ? undefined : detail.query;
  const query = (shortcode: string) =>
    queryRef === undefined
      ? `entityDetailFor(${JSON.stringify(entity.key)}).queryOptions(${shortcode})`
      : `${queryRef.export}(${shortcode})`;
  const imports = [
    'import { createFileRoute } from "@tanstack/react-router";',
    "",
    importLine(GENERIC_DETAIL),
    'import { ensureDetailRecord } from "~/app/_components/routing/detail-loader";',
    'import { detailPage, notFoundPage } from "~/app/_components/routing/entity-routes";',
    'import { RouteErrorComponent } from "~/components/lazy-route-error";',
    'import { DetailPagePending } from "~/components/route-pending";',
    queryRef === undefined
      ? 'import { entityDetailFor } from "~/entities/entity-detail.functions";'
      : importLine(queryRef),
    'import { shortcodeHead } from "~/lib/page-title";',
  ];
  return (
    generatedHeader +
    `${imports.join("\n")}\n\n` +
    splitterNote +
    `const ${name}DetailPage = detailPage({\n` +
    `  entity: ${JSON.stringify(entity.key)},\n` +
    `  query: (${detailParam}) => ${query(detailParam)},\n` +
    `  render: (record, ${detailParam}) => <${GENERIC_DETAIL.export} key={${detailParam}} entity=${JSON.stringify(entity.key)} record={record} />,\n` +
    `  title: (record) => record.${entity.inspector.titleField},\n` +
    "});\n\n" +
    `const ${name}NotFound = notFoundPage(${JSON.stringify(entity.key)});\n\n` +
    `export const Route = createFileRoute(${JSON.stringify(`/_authenticated/${basePath}/$${detailParam}`)})({\n` +
    "  loader: ({ params, context, location }) =>\n" +
    `    ensureDetailRecord(context.queryClient, ${query(`params.${detailParam}`)}, {\n` +
    `      shortcode: params.${detailParam},\n` +
    "      href: location.href,\n" +
    "    }),\n" +
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
 * extraneous-file cleanup covers them.
 */
export const renderBrowserRouteArtifacts = (
  entities: readonly CompiledEntity[],
): EntityArtifacts[] => {
  const listed = new Set(
    entityProjectionMaps(entities).list.map((entity) => entity.key),
  );
  const directory = "apps/web/src/routes/_authenticated";
  const modules = entities
    .filter(
      (entity): entity is RoutedEntity =>
        entity.route !== null && entity.descriptor.browserRoutes !== false,
    )
    .flatMap((entity) => {
      const { basePath, detailParam } = browserRoutes(entity);
      return [
        ...(entity.route.list === null
          ? []
          : [
              {
                relativePath: `${directory}/${basePath}.index.tsx`,
                source: renderIndexRoute(entity, listed.has(entity.key)),
              },
            ]),
        ...(entity.route.detail === null
          ? []
          : [
              {
                relativePath: `${directory}/${basePath}.$${detailParam}.tsx`,
                source: renderDetailRoute(entity, entity.route.detail),
              },
            ]),
      ];
    });
  // The modules sit beside hand-written routes, so the directory's own
  // ignore file (itself generated, and ignoring itself) keeps them out of git.
  return [
    ...modules,
    {
      relativePath: `${directory}/.gitignore`,
      source:
        yamlGeneratedHeader +
        [
          ".gitignore",
          ...modules.map(({ relativePath }) =>
            relativePath.slice(directory.length + 1),
          ),
        ]
          .map((name) => `/${name}\n`)
          .join(""),
    },
  ];
};
