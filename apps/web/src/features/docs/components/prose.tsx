import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

interface ProseProps {
  children: ReactNode;
  className?: string;
}

export function Prose({ children, className }: ProseProps) {
  return (
    <div
      className={cn(
        "max-w-none min-w-0 break-words",
        "[&_h1]:mb-4 [&_h1]:font-heading [&_h1]:text-3xl [&_h1]:font-bold [&_h1]:tracking-tight",
        "[&_h2]:mt-6 [&_h2]:mb-2 [&_h2]:border-b [&_h2]:border-border [&_h2]:pb-2 [&_h2]:font-heading [&_h2]:text-2xl [&_h2]:font-semibold",
        "[&_h3]:mt-6 [&_h3]:mb-2 [&_h3]:font-heading [&_h3]:text-xl [&_h3]:font-medium",
        "[&_p]:mb-4 [&_p]:leading-7 [&_p]:text-muted-foreground",
        "[&_strong]:font-medium [&_strong]:text-foreground",
        "[&_ul]:mb-4 [&_ul]:ml-6 [&_ul]:list-disc [&_ul]:space-y-1",
        "[&_ol]:mb-4 [&_ol]:ml-6 [&_ol]:list-decimal [&_ol]:space-y-1",
        "[&_li]:text-muted-foreground",
        "[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-4 hover:[&_a]:text-primary/80",
        "[&_code]:rounded [&_code]:bg-muted [&_code]:px-2 [&_code]:py-1 [&_code]:font-mono [&_code]:text-sm",
        "[&_pre]:my-4 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0",
        className,
      )}
    >
      {children}
    </div>
  );
}
