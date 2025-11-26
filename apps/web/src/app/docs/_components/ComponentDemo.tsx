"use client";

import { type ReactNode } from "react";
import { cn } from "~/lib/utils";

interface ComponentDemoProps {
  title?: string;
  description?: string;
  children: ReactNode;
  className?: string;
}

/**
 * Wrapper component for live interactive demos in documentation.
 * Shows an "Interactive" badge and renders the demo in a styled container.
 */
export function ComponentDemo({
  title,
  description,
  children,
  className,
}: ComponentDemoProps) {
  return (
    <div className={cn("my-8", className)}>
      {/* Header */}
      <div className="mb-3 flex items-center gap-3">
        <span className="inline-flex items-center rounded bg-green-100 px-2 py-1 text-xs font-medium text-green-800 dark:bg-green-900/30 dark:text-green-400">
          Interactive
        </span>
        {title && <span className="font-medium">{title}</span>}
      </div>

      {description && (
        <p className="text-muted-foreground mb-3 text-sm">{description}</p>
      )}

      {/* Demo content */}
      <div className="bg-card overflow-hidden rounded-lg border">
        <div className="p-6">{children}</div>
      </div>
    </div>
  );
}
