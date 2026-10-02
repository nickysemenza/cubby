import { Row } from "~/ui/layout";
import { QuickActionsMenu } from "~/ui/navbar/quick-actions-menu";
import { UserAvatarDropdown } from "~/ui/navbar/user-avatar-dropdown";

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
