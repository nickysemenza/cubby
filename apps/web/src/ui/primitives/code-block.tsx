import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { CopyIcon } from "@phosphor-icons/react/dist/csr/Copy";
import { useEffect, useState, type ComponentProps } from "react";

import { copyText } from "~/lib/clipboard";
import { cn } from "~/lib/utils";
import { Button } from "~/ui/primitives/button";

// Adapted from the shadcn base-mira `code-block` registry item (AI Elements),
// trimmed to the plain block, its label and copy action.
// TODO: tokenize JSON payloads once a highlighter earns its bundle cost.

function CodeBlock({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="code-block"
      className={cn(
        "group/code-block relative flex w-full min-w-0 flex-col overflow-hidden rounded-sm border border-border bg-background text-xs text-foreground",
        className,
      )}
      {...props}
    />
  );
}

function CodeBlockHeader({
  className,
  label,
  value,
}: {
  className?: string;
  label: string;
  value: string;
}) {
  return (
    <div
      data-slot="code-block-header"
      className={cn(
        "flex min-w-0 items-center gap-2 border-b border-border bg-muted/40 py-0.5 pr-0.5 pl-2 text-muted-foreground",
        className,
      )}
    >
      <span className="min-w-0 truncate font-sans text-xs font-medium">
        {label}
      </span>
      <CodeBlockCopyButton value={value} label={label} />
    </div>
  );
}

function CodeBlockCopyButton({
  value,
  label,
}: {
  value: string;
  label: string;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timeout = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timeout);
  }, [copied]);
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="ms-auto"
        aria-label={copied ? `Copied ${label}` : `Copy ${label}`}
        onClick={() => {
          void copyText(value).then(setCopied);
        }}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </Button>
      <span aria-live="polite" className="sr-only">
        {copied ? "Copied" : ""}
      </span>
    </>
  );
}

function CodeBlockContent({ className, ...props }: ComponentProps<"pre">) {
  return (
    <pre
      data-slot="code-block-content"
      dir="ltr"
      tabIndex={0}
      className={cn(
        "max-h-80 min-w-0 overflow-auto px-2 py-1.5 font-mono text-xs/4 wrap-break-word whitespace-pre-wrap outline-none focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:ring-inset",
        className,
      )}
      {...props}
    />
  );
}

export { CodeBlock, CodeBlockHeader, CodeBlockContent };
