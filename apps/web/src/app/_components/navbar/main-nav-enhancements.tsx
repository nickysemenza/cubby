import { AuthenticatedShellControls } from "~/app/_components/navigation/authenticated-shell-controls";
import { cn } from "~/lib/utils";

import { desktopNav, isNavGroup } from "../navigation/nav-items";
import { NavDropdown } from "./nav-dropdown";
import { NavLink } from "./nav-link";

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

      <AuthenticatedShellControls
        debugClassName="hidden h-8 px-2 md:flex"
        includeAccount
      />
    </>
  );
}
