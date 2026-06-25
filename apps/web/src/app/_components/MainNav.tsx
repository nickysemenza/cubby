import { Link } from "@tanstack/react-router";
import { Bug, BugOff, Search } from "lucide-react";
import { Row } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { useDebug } from "~/hooks/useDebug";
import { useNavAuthed } from "~/hooks/useNavAuthed";
import { cn } from "~/lib/utils";
import { NavDropdown } from "./navbar/nav-dropdown";
import { NavLink } from "./navbar/nav-link";
import { ProblemsBadge } from "./navbar/problems-badge";
import { QuickActionsMenu } from "./navbar/quick-actions-menu";
import { UserAvatarDropdown } from "./navbar/user-avatar-dropdown";
import { desktopNav, isNavGroup, publicNavItems } from "./navigation/nav-items";

interface MainNavProps extends React.HTMLAttributes<HTMLElement> {
  onSearchClick?: () => void;
}

// cf https://github.com/shadcn-ui/ui/blob/main/apps/www/app/(app)/examples/dashboard/components/main-nav.tsx
export function MainNav({ className, onSearchClick, ...props }: MainNavProps) {
  const { isDebugEnabled, toggleDebug } = useDebug();
  // SSR-accurate auth (see useNavAuthed): correct logged-in/out on the first
  // paint from the signed cookie, then live once the client session resolves —
  // so the nav never flashes the wrong state in either direction.
  const authed = useNavAuthed();

  return (
    <div className="flex w-full items-center justify-between">
      <Link to="/">
        <Row align="center" gap="sm">
          <img src="/favicon.svg" alt="" className="h-6 w-6 sm:h-7 sm:w-7" />
          <span className="self-center whitespace-nowrap font-bold font-heading text-foreground text-lg tracking-tight sm:text-xl">
            cubby
          </span>
        </Row>
      </Link>

      {/* Desktop Navigation */}
      <nav
        className={cn(
          "hidden items-center space-x-4 md:flex lg:space-x-6",
          className,
        )}
        {...props}
      >
        {(authed ? desktopNav : publicNavItems).map((node) =>
          isNavGroup(node) ? (
            <NavDropdown key={node.label} group={node} />
          ) : (
            <NavLink key={node.to} item={node} />
          ),
        )}
      </nav>

      <Row align="center" gap="sm">
        {/* Search Button */}
        {onSearchClick && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onSearchClick}
            className="hidden h-8 px-2 md:flex"
            title="Search"
          >
            <Search className="h-4 w-4" />
            <span className="sr-only">Search</span>
          </Button>
        )}

        {/* Quick Actions */}
        {authed && <QuickActionsMenu />}

        {/* Status Badges */}
        {authed && <ProblemsBadge />}

        {/* Debug Toggle */}
        <Button
          variant="ghost"
          size="sm"
          onClick={toggleDebug}
          className={cn(
            "hidden h-8 px-2 md:flex",
            isDebugEnabled && "bg-warning/30 text-accent-foreground",
          )}
          title={isDebugEnabled ? "Disable debug mode" : "Enable debug mode"}
        >
          {isDebugEnabled ? (
            <BugOff className="h-4 w-4" />
          ) : (
            <Bug className="h-4 w-4" />
          )}
          <span className="sr-only">Toggle debug mode</span>
        </Button>

        {authed ? (
          // The avatar dropdown shows its own neutral placeholder while the
          // client session is still resolving (see UserAvatarDropdown).
          <UserAvatarDropdown />
        ) : (
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
