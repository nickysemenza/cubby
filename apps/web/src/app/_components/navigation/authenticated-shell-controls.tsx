import { Bug, BugOff } from "lucide-react";
import { ProblemsBadge } from "~/app/_components/navbar/problems-badge";
import { QuickActionsMenu } from "~/app/_components/navbar/quick-actions-menu";
import { UserAvatarDropdown } from "~/app/_components/navbar/user-avatar-dropdown";
import { Row } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { useDebug } from "~/hooks/useDebug";
import { cn } from "~/lib/utils";

export function AuthenticatedShellControls() {
  const { isDebugEnabled, toggleDebug } = useDebug();

  return (
    <Row align="center" gap="sm" className="ml-auto lg:ml-2">
      <QuickActionsMenu />
      <ProblemsBadge />
      <Button
        variant="ghost"
        size="sm"
        onClick={toggleDebug}
        className={cn(
          "h-8 px-2",
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
    </Row>
  );
}

export function AuthenticatedShellAccount() {
  return <UserAvatarDropdown />;
}
