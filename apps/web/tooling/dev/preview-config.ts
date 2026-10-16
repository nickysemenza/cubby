import path from "node:path";
import { z } from "zod";
import type { DevProfile } from "../../../../scripts/lib/dev-profile";

/** Built bindings must follow every retry's origin, just like Vite's config. */
export function previewConfig(
  built: unknown,
  builtRoot: string,
  profile: DevProfile,
) {
  const config = z
    .object({
      main: z.string(),
      assets: z.object({ directory: z.string() }).passthrough(),
    })
    .passthrough()
    .parse(built);
  return {
    ...config,
    main: path.resolve(builtRoot, config.main),
    assets: {
      ...config.assets,
      directory: path.resolve(builtRoot, config.assets.directory),
    },
    vars: profile.vars,
  };
}
