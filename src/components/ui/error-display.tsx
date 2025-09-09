"use client";

import { AlertCircle } from "lucide-react";
import { SignInButton } from "@clerk/nextjs";
import { Button } from "~/components/ui/button";

interface ErrorDisplayProps {
  error: unknown;
  className?: string;
}

export function ErrorDisplay({ error, className }: ErrorDisplayProps) {
  const isErrorWithData = (
    err: unknown,
  ): err is { data?: { code?: string }; message?: string } => {
    return typeof err === "object" && err !== null;
  };

  const typedError = isErrorWithData(error) ? error : null;

  return (
    <div
      role="alert"
      className={`flex items-center justify-center gap-2 text-red-600 ${className || ""}`}
    >
      <AlertCircle className="h-4 w-4" aria-hidden="true" />
      {typedError?.data?.code === "UNAUTHORIZED" ? (
        <div className="flex items-center gap-2">
          <span>Please sign in to continue</span>
          <SignInButton mode="modal">
            <Button variant="link" size="sm">
              Sign in
            </Button>
          </SignInButton>
        </div>
      ) : (
        <span>{typedError?.message || "An error occurred"}</span>
      )}
    </div>
  );
}
