import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { Link } from "@tanstack/react-router";
import type * as React from "react";

import { preloadCommandMenu } from "~/app/_components/command-menu-loader";
import { Row } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { useHydrated } from "~/hooks/useHydrated";
import { useNavAuthed } from "~/hooks/useNavAuthed";

import { MainNavEnhancements } from "./navbar/main-nav-enhancements";

interface MainNavProps extends React.HTMLAttributes<HTMLElement> {
  onSearchClick?: () => void;
}

// Localhost shows a hot-magenta variant so the dev tab/navbar is obvious among
// prod tabs (matches the conditional favicon in __root.tsx).
const LOGO_SRC = import.meta.env.DEV ? "/favicon-dev.svg" : "/favicon.svg";

// cf https://github.com/shadcn-ui/ui/blob/main/apps/www/app/(app)/examples/dashboard/components/main-nav.tsx
export function MainNav({ className, onSearchClick, ...props }: MainNavProps) {
  // SSR-accurate auth (see useNavAuthed): correct logged-in/out on the first
  // paint from the signed cookie, then live once the client session resolves —
  // so the nav never flashes the wrong state in either direction.
  const authed = useNavAuthed();
  const hydrated = useHydrated();

  return (
    <div
      className="flex w-full items-center justify-between"
      data-nav-hydrated={hydrated ? "true" : "false"}
    >
      <Link to="/" className="flex min-h-11 items-center md:min-h-0">
        <Row align="center" gap="sm">
          <img src={LOGO_SRC} alt="" className="size-6 sm:h-7 sm:w-7" />
          <span className="self-center font-heading text-lg font-bold tracking-tight whitespace-nowrap text-foreground sm:text-xl">
            cubby
          </span>
        </Row>
      </Link>

      {authed ? (
        <MainNavEnhancements className={className} {...props} />
      ) : !authed ? (
        <nav
          className="ml-6 hidden items-center space-x-4 md:flex lg:space-x-6"
          {...props}
        >
          <Link to="/" className="text-sm font-medium text-muted-foreground">
            Home
          </Link>
          <Link
            to="/docs"
            className="text-sm font-medium text-muted-foreground"
          >
            Docs
          </Link>
        </nav>
      ) : null}

      <Row align="center" gap="sm" className="ml-auto">
        {/* Search Button */}
        {onSearchClick && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onSearchClick}
            onPointerEnter={preloadCommandMenu}
            onFocus={preloadCommandMenu}
            onTouchStart={preloadCommandMenu}
            className="hidden h-8 px-2 md:flex"
            title="Search"
          >
            <MagnifyingGlassIcon className="size-3.5" />
            <span className="sr-only">Search</span>
          </Button>
        )}

        {!authed && (
          <Link
            to="/auth/$authView"
            params={{ authView: "sign-in" }}
            className="text-sm font-medium"
          >
            Sign In
          </Link>
        )}
      </Row>
    </div>
  );
}
