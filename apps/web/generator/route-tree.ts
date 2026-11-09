import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Generator, getConfig } from "@tanstack/router-generator";

/**
 * `apps/web/src/routeTree.gen.ts`, written the way the TanStack Start Vite
 * plugin writes it, so typecheck and tests work before any Vite run. The
 * footer is Start's `Register` declaration (`buildRouteTreeFileFooter` in
 * `@tanstack/start-plugin-core`); the ignore pattern mirrors `vite.config.ts`.
 */
export const writeRouteTree = async (root: string) => {
  const webRoot = resolve(root, "apps/web");
  const config = getConfig(
    {
      target: "react",
      routesDirectory: "./src/routes",
      generatedRouteTree: "./src/routeTree.gen.ts",
      routeFileIgnorePattern: "\\.(test|spec)\\.[jt]sx?$",
      routeTreeFileFooter: [
        `import type { getRouter } from './router.tsx'
import type { startInstance } from './start.ts'
declare module '@tanstack/react-start' {
  interface Register {
    ssr: true
    router: Awaited<ReturnType<typeof getRouter>>
    config: Awaited<ReturnType<typeof startInstance.getOptions>>
  }
}`,
      ],
    },
    webRoot,
  );
  await new Generator({ config, root: webRoot }).run();
  writeRouterPaths(webRoot);
};

/** Router path patterns for the trace-route allowlist (`lib/http-route-template.ts`). */
const writeRouterPaths = (webRoot: string) => {
  const tree = readFileSync(resolve(webRoot, "src/routeTree.gen.ts"), "utf8");
  const paths = [
    ...new Set([...tree.matchAll(/fullPath: '([^']+)'/gu)].map((m) => m[1]!)),
  ].sort();
  writeFileSync(
    resolve(webRoot, "src/lib/generated/router-paths.gen.ts"),
    `// Generated from routeTree.gen.ts by generator/route-tree.ts.\nexport const ROUTER_PATHS = ${JSON.stringify(paths, null, 2)} as const;\n`,
  );
};
