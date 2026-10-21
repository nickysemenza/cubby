import { browserOnlyLazy } from "~/lib/browser-only-lazy";

function AccountPlaceholder() {
  return (
    <div
      className="size-10 animate-pulse rounded-full bg-muted/60 md:size-7"
      aria-hidden
    />
  );
}

// The account menu already renders this placeholder until hydration.
export const UserAvatarDropdown = browserOnlyLazy<object>(
  import.meta.env.SSR
    ? null
    : () =>
        import("./user-avatar-dropdown-content").then((module) => ({
          default: module.UserAvatarDropdown,
        })),
  AccountPlaceholder,
);
