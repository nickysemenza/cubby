import { Link, type LinkComponentProps } from "@tanstack/react-router";

import { cn } from "~/lib/utils";

/** Heading links keep a phone target without making the whole band clickable. */
export function SectionActionLink({
  className,
  ...props
}: LinkComponentProps<"a">) {
  return (
    <Link
      className={cn(
        "-mr-1 inline-flex min-h-11 shrink-0 items-center rounded-sm px-1 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring sm:mr-0 sm:min-h-0",
        className,
      )}
      {...props}
    />
  );
}
