import { Bug, BugOff } from "lucide-react";
import { Row } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { useDebug } from "~/hooks/useDebug";
import { cn } from "~/lib/utils";
import { desktopNav, isNavGroup } from "../navigation/nav-items";
import { NavDropdown } from "./nav-dropdown";
import { NavLink } from "./nav-link";
import { ProblemsBadge } from "./problems-badge";
import { QuickActionsMenu } from "./quick-actions-menu";
import { UserAvatarDropdown } from "./user-avatar-dropdown";

type MainNavEnhancementsProps = React.HTMLAttributes<HTMLElement>;

/**
 * Authenticated, interaction-heavy navigation chrome. Dropdown positioning,
 * tooltips, problem detectors, and account actions are useful after first
 * paint but should not be part of every route's eager JavaScript closure.
 */
export function MainNavEnhancements({
  className,
  ...props
}: MainNavEnhancementsProps) {
  const { isDebugEnabled, toggleDebug } = useDebug();

  return (
    <>
      <nav
        className={cn(
          "hidden items-center space-x-4 md:flex lg:space-x-6",
          className,
        )}
        {...props}
      >
        {desktopNav.map((node) =>
          isNavGroup(node) ? (
            <NavDropdown key={node.label} group={node} />
          ) : (
            <NavLink key={node.to} item={node} />
          ),
        )}
      </nav>

      <Row align="center" gap="sm">
        <QuickActionsMenu />
        <ProblemsBadge />
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
            <BugOff className="size-3.5" />
          ) : (
            <Bug className="size-3.5" />
          )}
          <span className="sr-only">Toggle debug mode</span>
        </Button>
        <UserAvatarDropdown />
      </Row>
    </>
  );
}
