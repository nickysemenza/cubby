import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

export type PageLayout = "contained" | "full" | "viewport";

interface PageWrapperProps {
  children: ReactNode;
  className?: string;
  layout?: PageLayout;
}

export const PageWrapper = ({
  children,
  className,
  layout = "contained",
}: PageWrapperProps) => {
  return (
    <div
      className={cn(
        "w-full min-w-0",
        // The ordinary reading measure caps at 80rem (90rem on large screens).
        // Dense tables opt into `full`; immersive tools reserve the viewport
        // between the shell's fixed top and bottom chrome.
        layout === "contained" &&
          "mx-auto max-w-7xl px-2 md:px-6 2xl:max-w-[90rem]",
        layout === "viewport" &&
          "h-[calc(100dvh-var(--app-chrome-top)-var(--app-chrome-bottom))] overflow-hidden",
        className,
      )}
    >
      {children}
    </div>
  );
};
