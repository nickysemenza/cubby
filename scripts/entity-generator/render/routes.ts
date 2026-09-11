import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CompiledEntity } from "../declarations.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

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

export const browserRoutes = (entity: CompiledEntity) => {
  const basePath = entity.route?.basePath ?? browserBasePath(entity.key);
  const detailParam =
    entity.route?.detailParam ??
    browserRouteExtension.get(entity.key)?.detailParam ??
    "shortcode";
  return {
    basePath,
    routes: { detail: `/${basePath}/$${detailParam}`, list: `/${basePath}` },
  };
};

export const expectedBrowserRouteFiles = (
  entities: readonly CompiledEntity[],
): readonly string[] =>
  entities
    .filter(({ descriptor }) => descriptor.browserRoutes !== false)
    .flatMap((entity) => {
      const { basePath, routes } = browserRoutes(entity);
      const detailParameter = routes.detail.slice(
        routes.detail.lastIndexOf("/$") + 1,
      );
      return [
        `apps/web/src/routes/_authenticated/${basePath}.index.tsx`,
        `apps/web/src/routes/_authenticated/${basePath}.${detailParameter}.tsx`,
      ];
    });

export const missingBrowserRouteFiles = (
  entities: readonly CompiledEntity[],
  exists: (path: string) => boolean = existsSync,
): readonly string[] =>
  expectedBrowserRouteFiles(entities).filter(
    (relativePath) => !exists(resolve(ROOT, relativePath)),
  );
