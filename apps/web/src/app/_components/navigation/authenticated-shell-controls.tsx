import { QuickActionsMenu } from "~/app/_components/navbar/quick-actions-menu";
import { UserAvatarDropdown } from "~/app/_components/navbar/user-avatar-dropdown";
import { Row } from "~/components/layout";

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
