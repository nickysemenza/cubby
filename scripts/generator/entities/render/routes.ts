import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CompiledEntity } from "../declarations.ts";

const ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);

/** PascalCase model name (as recorded in `descriptor.dbTable`) to its Drizzle export name. */
export const lowerCamelCase = (value: string): string =>
  value.length === 0
    ? value
    : `${value[0]?.toLowerCase() ?? ""}${value.slice(1)}`;

const browserRouteExtension = new Map<
  string,
  Readonly<{ basePath: string; detailParam?: string }>
>([
  ["inventory", { basePath: "inventory" }],
  ["usda-food", { basePath: "usda", detailParam: "id" }],
]);

const browserBasePath = (entity: string): string =>
  browserRouteExtension.get(entity)?.basePath ??
  (() => {
    const singular = entity.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
    return singular.endsWith("y")
      ? `${singular.slice(0, -1)}ies`
      : /(?:s|x|z|ch|sh)$/.test(singular)
        ? `${singular}es`
        : `${singular}s`;
  })();

interface BrowserRouteSet {
  detail: string;
  list: string;
  create?: "dialog" | "page";
  new?: string;
}

export const browserRoutes = (entity: CompiledEntity) => {
  const basePath = entity.route?.basePath ?? browserBasePath(entity.key);
  const detailParam =
    entity.route?.detailParam ??
    browserRouteExtension.get(entity.key)?.detailParam ??
    "shortcode";
  const detail = `/${basePath}/$${detailParam}`;
  const list = `/${basePath}`;
  // `routes.new` exists exactly when a hand-written `<basePath>.new.tsx`
  // does; a dialog-created entity deep-links through `?create=true`.
  const routes: BrowserRouteSet = {
    detail,
    list,
  };
  if (entity.route?.create !== undefined) routes.create = entity.route.create;
  if (entity.route?.create === "page") routes.new = `/${basePath}/new`;
  return { basePath, detailParam, routes };
};

const routeDirectory = "apps/web/src/routes/_authenticated";

const routedEntities = (entities: readonly CompiledEntity[]) =>
  entities.filter(
    (
      entity,
    ): entity is CompiledEntity & {
      route: NonNullable<CompiledEntity["route"]>;
    } => entity.route !== null && entity.descriptor.browserRoutes !== false,
  );

/** The route modules `render/browser-routes.ts` emits. */
export const generatedBrowserRouteFiles = (
  entities: readonly CompiledEntity[],
): readonly string[] =>
  routedEntities(entities).flatMap((entity) => {
    const { basePath, detailParam } = browserRoutes(entity);
    return [
      ...(entity.route.list === null
        ? []
        : [`${routeDirectory}/${basePath}.index.tsx`]),
      ...(entity.route.detail === null
        ? []
        : [`${routeDirectory}/${basePath}.$${detailParam}.tsx`]),
    ];
  });

/**
 * The route modules a declaration promises but leaves hand-written: a `null`
 * list or detail, and the `/new` page behind `create: "page"`.
 */
export const handWrittenBrowserRouteFiles = (
  entities: readonly CompiledEntity[],
): readonly string[] =>
  routedEntities(entities).flatMap((entity) => {
    const { basePath, detailParam } = browserRoutes(entity);
    return [
      ...(entity.route.list === null
        ? [`${routeDirectory}/${basePath}.index.tsx`]
        : []),
      ...(entity.route.detail === null
        ? [`${routeDirectory}/${basePath}.$${detailParam}.tsx`]
        : []),
      ...(entity.route.create === "page"
        ? [`${routeDirectory}/${basePath}.new.tsx`]
        : []),
    ];
  });

export const missingBrowserRouteFiles = (
  entities: readonly CompiledEntity[],
  exists: (path: string) => boolean = existsSync,
): readonly string[] =>
  handWrittenBrowserRouteFiles(entities).filter(
    (relativePath) => !exists(resolve(ROOT, relativePath)),
  );
