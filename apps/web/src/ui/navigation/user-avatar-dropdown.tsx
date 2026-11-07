import { useEffect, useState } from "react";

function AccountPlaceholder() {
  return (
    <div
      className="size-10 animate-pulse rounded-full bg-muted/60 md:size-7"
      aria-hidden
    />
  );
}

type AccountMenu =
  typeof import("./user-avatar-dropdown-content").UserAvatarDropdown;
type AccountMenuState =
  | { kind: "loading" }
  | { kind: "ready"; Component: AccountMenu }
  | { kind: "failed"; error: unknown };

let resolvedMenu: AccountMenu | undefined;
const loadMenu = import.meta.env.SSR
  ? null
  : () => import("./user-avatar-dropdown-content");

export function UserAvatarDropdown() {
  const [state, setState] = useState<AccountMenuState>(() =>
    resolvedMenu
      ? { kind: "ready", Component: resolvedMenu }
      : { kind: "loading" },
  );
  useEffect(() => {
    if (!loadMenu || state.kind !== "loading") return;
    let mounted = true;
    // A shell Suspense fallback can throttle hydration of the route's boundaries.
    void loadMenu().then(
      ({ UserAvatarDropdown: Component }) => {
        resolvedMenu = Component;
        if (mounted) setState({ kind: "ready", Component });
      },
      (error: unknown) => {
        if (mounted) setState({ kind: "failed", error });
      },
    );
    return () => {
      mounted = false;
    };
  }, [state.kind]);
  if (state.kind === "failed") throw state.error;
  if (state.kind === "loading") return <AccountPlaceholder />;
  const Content = state.Component;
  return <Content />;
}
