import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { pascalCase } from "../../../../packages/shared/src/text-case.ts";
import { generatedHeader, yamlGeneratedHeader } from "../../artifacts.ts";
import {
  EntityDeclarationError,
  type CompiledEntity,
  type EntityArtifacts,
  type SourceRef,
} from "../declarations.ts";
import { servesKernelGet } from "../list-capabilities.ts";
import {
  entityIdentifier,
  entityInspectorLoaderSource,
  entityModelExport,
  entityModelLoaderSource,
} from "./entity-models.ts";
import { isSlotListView } from "../../../../packages/schemas/src/entity-definitions/definition.ts";
import { descriptorRelations } from "./entity-models.ts";
import { entityProjectionMaps } from "./index.ts";
import { browserRoutes } from "./routes.ts";

const ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);
const CLIENTS = "apps/web/src/entity/generated/clients";
/** Hand-written, typed per-entity UI hooks (`<entity>.detail.tsx`, `<entity>.list.tsx`). */
const HOOKS = "apps/web/src/entity/clients";

type Surface = "detail" | "list";
const clientExport = (key: string, surface: Surface) =>
  `${entityIdentifier(key)}${surface === "detail" ? "Detail" : "List"}Client`;
const clientModule = (key: string, surface: Surface) =>
  `~/entity/generated/clients/${key}.${surface}.gen`;
const hooksExport = (key: string, surface: Surface) =>
  `${entityIdentifier(key)}${surface === "detail" ? "Detail" : "List"}Hooks`;
const hasHooksModule = (key: string, surface: Surface) =>
  existsSync(resolve(ROOT, `${HOOKS}/${key}.${surface}.tsx`));

/** The page gets a generic detail client: every routed kernel `get` entity. */
const hasDetailClient = (entity: CompiledEntity) =>
  entity.route !== null &&
  entity.descriptor.browserRoutes !== false &&
  servesKernelGet(entity);
/** A generated index, or a hand-written one over the generic list page. */
const hasListClient = (entity: CompiledEntity) =>
  entity.route !== null &&
  entity.descriptor.browserRoutes !== false &&
  (entity.route.list !== null || entity.route.listColumns !== undefined);

const declaresSlots = (entity: CompiledEntity, surface: Surface) =>
  surface === "detail"
    ? entity.inspector.detail.sections.some(({ kind }) => kind === "slot")
    : entity.inspector.list.views.some(isSlotListView);

/**
 * The relation-section targets of one entity's detail page: their tables
 * render the target's columns, so the client module starts loading those
 * models as it evaluates, in parallel with the page's own render.
 */
const relationTargets = (entity: CompiledEntity): readonly string[] => {
  const relationships = descriptorRelations(entity);
  const targets = entity.inspector.detail.sections.flatMap((section) => {
    if (section.kind !== "relation") return [];
    const target = relationships.find(
      ({ key }) => key === section.relation,
    )?.target;
    return target !== undefined && target !== entity.key ? [target] : [];
  });
  return [...new Set(targets)];
};

/**
 * One entity surface's client module: registers its model, starts loading
 * its relation targets' models, and binds the entity's typed UI hooks (slots, header, section and
 * collection actions). The route's component chunk imports it statically, so
 * the router fetches it in parallel with the loader and it is evaluated
 * before the page renders or hydrates.
 */
const renderClientModule = (
  entity: CompiledEntity,
  surface: Surface,
): EntityArtifacts => {
  const { key } = entity;
  const hooks = hasHooksModule(key, surface);
  if (!hooks && declaresSlots(entity, surface))
    throw new EntityDeclarationError(
      `${key} declares ${surface} slots but ${HOOKS}/${key}.${surface}.tsx does not exist.`,
    );
  const prefetch = surface === "detail" ? relationTargets(entity) : [];
  const define =
    surface === "detail" ? "defineDetailClient" : "defineListClient";
  const defineModule =
    surface === "detail"
      ? "~/entity/entity-detail/detail-hooks"
      : "~/entity/entity-list/list-hooks";
  return {
    relativePath: `${CLIENTS}/${key}.${surface}.gen.ts`,
    source:
      generatedHeader +
      `import { ${entityModelExport(key)} } from ${JSON.stringify(`@cubby/schemas/entity-models/${key}`)};\n` +
      (prefetch.length > 0
        ? 'import { loadEntityModels, registerEntityModels } from "~/entity/entity-model";\n'
        : 'import { registerEntityModels } from "~/entity/entity-model";\n') +
      `import { ${define} } from ${JSON.stringify(defineModule)};\n` +
      (hooks
        ? `import { ${hooksExport(key, surface)} } from ${JSON.stringify(`~/entity/clients/${key}.${surface}`)};\n`
        : "") +
      "\n" +
      `registerEntityModels(${entityModelExport(key)});\n` +
      (prefetch.length > 0
        ? `// Relation sections render these entities' columns.\nvoid loadEntityModels(${JSON.stringify(prefetch)});\n`
        : "") +
      "\n" +
      `export const ${clientExport(key, surface)} = ${define}(${JSON.stringify(key)}, ${hooks ? hooksExport(key, surface) : "{}"});\n`,
  };
};

/** Loaders for one entity's model or inspector, for surfaces outside its own routes. */
const renderModelLoaders = (
  entities: readonly CompiledEntity[],
): EntityArtifacts => ({
  relativePath: "apps/web/src/entity/generated/entity-model-loaders.gen.ts",
  source:
    generatedHeader +
    'import type { Entity } from "@cubby/schemas/entity";\n\n' +
    "// One dynamic import per entity: a page loads only the models it reads.\n" +
    "// oxfmt-ignore\n" +
    `export const entityModelLoaders = {\n${entities
      .map(
        ({ key }) =>
          `  ${JSON.stringify(key)}: ${entityModelLoaderSource(key)},\n`,
      )
      .join("")}} as const satisfies Record<Entity, unknown>;\n\n` +
    "// oxfmt-ignore\n" +
    `export const entityInspectorLoaders = {\n${entities
      .map(
        ({ key }) =>
          `  ${JSON.stringify(key)}: ${entityInspectorLoaderSource(key)},\n`,
      )
      .join("")}} as const satisfies Record<Entity, unknown>;\n`,
});

const importLine = (ref: SourceRef) =>
  `import { ${ref.export} } from ${JSON.stringify(ref.module)};`;

// The router plugin's splitter re-parses an inlined call expression with a
// JSX-less babel config, so page bodies are bound to consts and only the
// identifier reaches the literal options object (see `list-page.tsx`).
const splitterNote =
  "// Bound to a const, not inlined into the options object: the router plugin's\n" +
  "// splitter re-parses an inlined call expression with a JSX-less babel config,\n" +
  "// so only the identifier path survives a page body that renders JSX.\n";

type RoutedEntity = CompiledEntity & {
  route: NonNullable<CompiledEntity["route"]>;
};

const GENERIC_DETAIL = {
  module: "~/entity/entity-detail/generic-entity-detail",
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
          'import { CreateDialogAction } from "~/ui/forms/create-dialog-action";',
        ]
      : []),
    'import { listPage } from "~/entity/routing/list-page";',
    `import { ${clientExport(entity.key, "list")} } from ${JSON.stringify(clientModule(entity.key, "list"))};`,
    ...(entity.route.listColumns ? [importLine(entity.route.listColumns)] : []),
    ...(entity.route.create === "page"
      ? ['import { Button } from "~/ui/primitives/button";']
      : []),
    ...(entity.route.create === "dialog"
      ? ['import { captureRequest } from "~/entity/editing/editor-requests";']
      : []),
    ...(listed
      ? ['import { entityListLoader } from "~/entity/entity-list-ssr";']
      : []),
    'import { entitySearch } from "~/entity/generated/entity-search.gen";',
    'import { pageTitle } from "~/lib/page-title";',
  ];
  return (
    generatedHeader +
    `${imports.join("\n")}\n\n` +
    splitterNote +
    `const ${page} = listPage({\n` +
    `  client: ${clientExport(entity.key, "list")},\n` +
    (entity.route.listColumns
      ? `  override: ${entity.route.listColumns.export},\n`
      : "") +
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

/**
 * A dialog-created entity has no form route: its capture dialog is the list's
 * `?create=true`. This static `/new` keeps a bookmark or share link off the
 * `/$shortcode` detail route (which would read "new" as a record id).
 */
const renderNewRoute = (entity: RoutedEntity): string => {
  const { basePath } = browserRoutes(entity);
  return (
    generatedHeader +
    'import { createFileRoute, redirect } from "@tanstack/react-router";\n\n' +
    `export const Route = createFileRoute(${JSON.stringify(`/_authenticated/${basePath}/new`)})({\n` +
    "  beforeLoad: () => {\n" +
    `    throw redirect({ to: ${JSON.stringify(`/${basePath}`)}, search: { create: true }, replace: true });\n` +
    "  },\n" +
    "});\n"
  );
};

const renderDetailRoute = (entity: RoutedEntity): string => {
  const { basePath, detailParam } = browserRoutes(entity);
  const name = pascalCase(basePath);
  const query = (shortcode: string) =>
    `entityDetailFor(${JSON.stringify(entity.key)}).queryOptions(${shortcode})`;
  const imports = [
    'import { createFileRoute } from "@tanstack/react-router";',
    "",
    importLine(GENERIC_DETAIL),
    'import { ensureDetailRecord } from "~/entity/routing/detail-loader";',
    'import { detailPage, notFoundPage } from "~/entity/routing/detail-page";',
    `import { ${clientExport(entity.key, "detail")} } from ${JSON.stringify(clientModule(entity.key, "detail"))};`,
    'import { RouteErrorComponent } from "~/ui/route-error";',
    'import { DetailPagePending } from "~/ui/route-pending";',
    'import { entityDetailFor } from "~/entity/entity-detail";',
    'import { shortcodeHead } from "~/lib/page-title";',
  ];
  return (
    generatedHeader +
    `${imports.join("\n")}\n\n` +
    splitterNote +
    `const ${name}DetailPage = detailPage({\n` +
    `  client: ${clientExport(entity.key, "detail")},\n` +
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
 * The boilerplate list, detail and `/new` redirect route modules, one per
 * `route.list` / `route.detail` / dialog `route.create` declaration. They live beside the hand-written routes
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
                source: renderDetailRoute(entity),
              },
            ]),
        ...(entity.route.create === "dialog"
          ? [
              {
                relativePath: `${directory}/${basePath}.new.tsx`,
                source: renderNewRoute(entity),
              },
            ]
          : []),
      ];
    });
  // The modules sit beside hand-written routes, so the directory's own
  // ignore file (itself generated, and ignoring itself) keeps them out of git.
  const clients = entities.flatMap((entity) => [
    ...(hasDetailClient(entity) ? [renderClientModule(entity, "detail")] : []),
    ...(hasListClient(entity) ? [renderClientModule(entity, "list")] : []),
  ]);
  return [
    ...modules,
    ...clients,
    renderModelLoaders(entities),
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
