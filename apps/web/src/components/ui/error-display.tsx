"use client";

import { AlertCircle } from "lucide-react";
import Link from "next/link";
import { Button } from "~/components/ui/button";
import { OrganizationSwitcher } from "@daveyplate/better-auth-ui";
import { getAppErrorDetails } from "~/lib/error-utils";
import { FlexContainer } from "~/components/ui/flex-container";
import { cn } from "~/lib/utils";

interface ErrorDisplayProps {
  error: unknown;
  className?: string;
}

export function ErrorDisplay({ error, className }: ErrorDisplayProps) {
  const { code, reason, message } = getAppErrorDetails(error);

  return (
    <FlexContainer
      role="alert"
      align="center"
      justify="center"
      gap={2}
      className={cn("text-destructive", className)}
    >
      <AlertCircle className="h-4 w-4" aria-hidden="true" />
      {code === "UNAUTHORIZED" ? (
        <FlexContainer align="center" gap={2}>
          <span>Please sign in to continue</span>
          <Button asChild variant="link" size="sm">
            <Link href="/auth/sign-in">Sign in</Link>
          </Button>
        </FlexContainer>
      ) : code === "PRECONDITION_FAILED" ||
        reason === "NO_ORGANIZATION_SELECTED" ? (
        <FlexContainer align="center" gap={3}>
          <span>Please select an organization to continue</span>
          <OrganizationSwitcher />
        </FlexContainer>
      ) : (
        <span>
          {reason && <span className="font-mono text-sm">[{reason}]</span>}{" "}
          {message}
        </span>
      )}
    </FlexContainer>
  );
}
