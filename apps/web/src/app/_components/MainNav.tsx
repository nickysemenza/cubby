import { Link } from "@tanstack/react-router";
import { Search } from "lucide-react";
import * as React from "react";
import { preloadCommandMenu } from "~/app/_components/command-menu-loader";
import { Row } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { useNavAuthed } from "~/hooks/useNavAuthed";

const MainNavEnhancements = React.lazy(() =>
  import("./navbar/main-nav-enhancements").then((m) => ({
    default: m.MainNavEnhancements,
  })),
);

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

  return (
    <div className="flex w-full items-center justify-between">
      <Link to="/">
        <Row align="center" gap="sm">
          <img src={LOGO_SRC} alt="" className="size-6 sm:h-7 sm:w-7" />
          <span className="self-center whitespace-nowrap font-bold font-heading text-foreground text-lg tracking-tight sm:text-xl">
            cubby
          </span>
        </Row>
      </Link>

      {authed ? (
        <React.Suspense
          fallback={
            <nav
              className="hidden h-8 min-w-80 items-center justify-end gap-4 md:flex"
              aria-hidden="true"
            >
              <span className="h-3.5 w-14 rounded-sm bg-muted" />
              <span className="h-3.5 w-16 rounded-sm bg-muted" />
              <span className="h-3.5 w-12 rounded-sm bg-muted" />
              <span className="size-7 rounded-full bg-muted" />
            </nav>
          }
        >
          <MainNavEnhancements className={className} {...props} />
        </React.Suspense>
      ) : !authed ? (
        <nav
          className="hidden items-center space-x-4 md:flex lg:space-x-6"
          {...props}
        >
          <Link to="/" className="font-medium text-muted-foreground text-sm">
            Home
          </Link>
          <Link
            to="/docs"
            className="font-medium text-muted-foreground text-sm"
          >
            Docs
          </Link>
          <Link
            to="/design"
            className="font-medium text-muted-foreground text-sm"
          >
            Design
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
            <Search className="size-3.5" />
            <span className="sr-only">Search</span>
          </Button>
        )}

        {!authed && (
          <Link
            to="/auth/$authView"
            params={{ authView: "sign-in" }}
            className="font-medium text-sm"
          >
            Sign In
          </Link>
        )}
      </Row>
    </div>
  );
}
