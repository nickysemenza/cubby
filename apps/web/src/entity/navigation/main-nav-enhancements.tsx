import { AuthenticatedShellControls } from "~/entity/navigation/authenticated-shell-controls";
import { cn } from "~/lib/utils";

import { NavDropdown } from "./nav-dropdown";
import { navGroups, topNavItems } from "./nav-items";
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
        {topNavItems.map((item) => (
          <NavLink key={item.to} item={item} />
        ))}
        {navGroups.map((group) => (
          <NavDropdown key={group.id} group={group} />
        ))}
      </nav>

      <AuthenticatedShellControls includeAccount />
    </>
  );
}
