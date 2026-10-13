import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { ClipboardIcon } from "@phosphor-icons/react/dist/csr/Clipboard";
import { useState } from "react";

import { copyShortcodes } from "~/lib/clipboard";
import { cn } from "~/lib/utils";

/**
 * A shortcode, click-to-copy.
 *
 * The shortcode is the id every other surface speaks — MCP payloads, QR labels,
 * URLs — so wherever one is on screen it should hand itself over rather than be
 * retypeable-only. Not a `Button`: it sits inline in breadcrumb and metadata
 * type, and a button variant would fight that type. The caller's `className`
 * sets the tone and size of the surrounding line.
 */
export function CopyableShortcode({
  code,
  className,
}: {
  code: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      title="Copy shortcode"
      className={cn(
        "inline-flex items-center gap-1 font-mono transition-colors hover:text-primary",
        className,
      )}
      onClick={async () => {
        if (!(await copyShortcodes([code]))) return;
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {code}
      {copied ? (
        <CheckIcon className="size-3" />
      ) : (
        <ClipboardIcon className="size-3 opacity-60" />
      )}
    </button>
  );
}
