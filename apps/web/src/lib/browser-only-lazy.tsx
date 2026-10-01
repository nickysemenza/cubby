import { type ComponentType, lazy } from "react";

/**
 * `React.lazy` for a component that only works in the browser (canvas, WebGL,
 * Web Worker layout). Call it as
 *
 *   browserOnlyLazy<ComponentProps<typeof Canvas>>(  // `import type { Canvas }`
 *     import.meta.env.SSR ? null : () => import("./canvas").then(...),
 *     Placeholder,
 *   )
 *
 * The guard must sit at the call site: `import.meta.env.SSR` is a build-time
 * constant there, so the Worker build reduces the loader to `null` and the
 * dynamic import — with everything behind it — never reaches the uploaded
 * bundle. Unused uploaded JavaScript still costs isolate startup, which users
 * pay as multi-second first requests.
 *
 * The server renders `Placeholder`; make it the same markup as the
 * surrounding Suspense fallback so server HTML and the client's suspended
 * first render agree.
 */
export function browserOnlyLazy<Props extends object>(
  load: (() => Promise<{ default: ComponentType<Props> }>) | null,
  Placeholder: ComponentType,
) {
  const ServerPlaceholder = (_props: Props) => <Placeholder />;
  return lazy(load ?? (() => Promise.resolve({ default: ServerPlaceholder })));
}
