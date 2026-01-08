import { Link } from "@tanstack/react-router";
import { LockKeyhole } from "lucide-react";
import { Button } from "~/components/ui/button";
import {
  Empty,
  EmptyActions,
  EmptyDescription,
  EmptyIcon,
  EmptyTitle,
} from "~/components/ui/empty";

interface SignInPromptProps {
  feature?: string;
}

export function SignInPrompt({ feature = "this feature" }: SignInPromptProps) {
  return (
    <Empty variant="warm">
      <EmptyIcon icon={LockKeyhole} />
      <EmptyTitle>Sign in to access {feature}</EmptyTitle>
      <EmptyDescription>
        Create an account or sign in to manage your inventory, products, and
        recipes.
      </EmptyDescription>
      <EmptyActions>
        <Button
          render={
            <Link to="/auth/$authView" params={{ authView: "sign-in" }} />
          }
        >
          Sign in
        </Button>
      </EmptyActions>
    </Empty>
  );
}
