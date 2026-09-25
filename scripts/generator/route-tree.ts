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
};
