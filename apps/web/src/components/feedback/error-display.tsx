"use client";

import { OrganizationSwitcher } from "@daveyplate/better-auth-ui";
import { AlertCircle } from "lucide-react";
import Link from "next/link";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { getAppErrorDetails } from "~/lib/error-utils";

interface ErrorDisplayProps {
  error: unknown;
  className?: string;
}

export function ErrorDisplay({ error, className }: ErrorDisplayProps) {
  const { code, reason, message } = getAppErrorDetails(error);

  return (
    <Alert variant="destructive" className={className}>
      <AlertCircle className="h-4 w-4" />
      <AlertDescription>
        {code === "UNAUTHORIZED" ? (
          <div className="flex items-center gap-2">
            <span>Please sign in to continue</span>
            <Button
              variant="link"
              size="sm"
              render={<Link href="/auth/sign-in" />}
              nativeButton={false}
            >
              Sign in
            </Button>
          </div>
        ) : code === "PRECONDITION_FAILED" ||
          reason === "NO_ORGANIZATION_SELECTED" ? (
          <div className="flex items-center gap-3">
            <span>Please select an organization to continue</span>
            <OrganizationSwitcher />
          </div>
        ) : (
          <span>
            {reason && <span className="font-mono text-sm">[{reason}]</span>}{" "}
            {message}
          </span>
        )}
      </AlertDescription>
    </Alert>
  );
}
