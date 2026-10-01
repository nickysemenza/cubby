import { type ComponentType, lazy, Suspense } from "react";

import { useHydrated } from "~/hooks/useHydrated";

/**
 * A lazily loaded component that only works in the browser (canvas, WebGL,
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
 * The returned component renders `Placeholder` on the server and on the first
 * client render, then the real component (behind a Suspense showing the same
 * placeholder) once hydrated, so server HTML and hydration always agree.
 *
 * Omit `Placeholder` for something only mounted after user interaction (a
 * dialog, a popover body), which never appears in server HTML. It then renders
 * nothing before hydration and adds no Suspense boundary of its own, so its
 * chunk load shows the caller's loading fallback.
 */
export function browserOnlyLazy<Props extends object>(
  load: (() => Promise<{ default: ComponentType<Props> }>) | null,
  Placeholder?: ComponentType,
) {
  const Lazy = load ? lazy(load) : null;
  return function BrowserOnly(props: Props) {
    const hydrated = useHydrated();
    if (!hydrated || !Lazy) return Placeholder ? <Placeholder /> : null;
    if (!Placeholder) return <Lazy {...props} />;
    return (
      <Suspense fallback={<Placeholder />}>
        <Lazy {...props} />
      </Suspense>
    );
  };
}
