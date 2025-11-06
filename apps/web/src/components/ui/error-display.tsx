"use client";

import { AlertCircle } from "lucide-react";
import Link from "next/link";
import { Button } from "~/components/ui/button";
import { OrganizationSwitcher } from "@daveyplate/better-auth-ui";
import { getAppErrorDetails } from "~/lib/error-utils";
import { AppErrorReason } from "~/lib/app-error-codes";

interface ErrorDisplayProps {
  error: unknown;
  className?: string;
}

export function ErrorDisplay({ error, className }: ErrorDisplayProps) {
  const { code, reason, message } = getAppErrorDetails(error);

  return (
    <div
      role="alert"
      className={`flex items-center justify-center gap-2 text-red-600 ${className || ""}`}
    >
      <AlertCircle className="h-4 w-4" aria-hidden="true" />
      {code === "UNAUTHORIZED" ? (
        <div className="flex items-center gap-2">
          <span>Please sign in to continue</span>
          <Button asChild variant="link" size="sm">
            <Link href="/auth/sign-in">Sign in</Link>
          </Button>
        </div>
      ) : code === "PRECONDITION_FAILED" ||
        reason === AppErrorReason.NO_ORGANIZATION_SELECTED ? (
        <div className="flex items-center gap-3">
          <span>Please select an organization to continue</span>
          <OrganizationSwitcher />
        </div>
      ) : (
        <span>{message}</span>
      )}
    </div>
  );
}
