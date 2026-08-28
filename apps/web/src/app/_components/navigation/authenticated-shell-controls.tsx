import { ProblemsBadge } from "~/app/_components/navbar/problems-badge";
import { QuickActionsMenu } from "~/app/_components/navbar/quick-actions-menu";
import { UserAvatarDropdown } from "~/app/_components/navbar/user-avatar-dropdown";
import { Row } from "~/components/layout";

import { DebugToggleButton } from "./debug-toggle-button";

type AuthenticatedShellControlsProps = {
  debugClassName?: string;
  includeAccount?: boolean;
};

export function AuthenticatedShellControls({
  debugClassName,
  includeAccount,
}: AuthenticatedShellControlsProps) {
  return (
    <Row align="center" gap="sm" className="ml-auto lg:ml-2">
      <QuickActionsMenu />
      <ProblemsBadge />
      <DebugToggleButton className={debugClassName} />
      {includeAccount && <UserAvatarDropdown />}
    </Row>
  );
}

export const AuthenticatedShellAccount = UserAvatarDropdown;
