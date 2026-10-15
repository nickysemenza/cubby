import { QuickActionsMenu } from "~/entity/navigation/quick-actions-menu";
import { Row } from "~/ui/layout";
import { UserAvatarDropdown } from "~/ui/navigation/user-avatar-dropdown";

type AuthenticatedShellControlsProps = {
  includeAccount?: boolean;
};

export function AuthenticatedShellControls({
  includeAccount,
}: AuthenticatedShellControlsProps) {
  return (
    <Row align="center" gap="sm" className="ml-auto lg:ml-2">
      <QuickActionsMenu />
      {includeAccount && <UserAvatarDropdown />}
    </Row>
  );
}

export const AuthenticatedShellAccount = UserAvatarDropdown;
