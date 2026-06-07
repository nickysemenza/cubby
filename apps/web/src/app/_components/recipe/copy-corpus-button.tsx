import type { Amount } from "@cubby/schemas/codec";
import { Check, ClipboardCopy } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";

/**
 * Render the raw import line alongside how cubby parsed it, as a plain paste-ready
 * block to drop into a Claude session on the `ingredient-parser` repo. Kept
 * deliberately format-agnostic — just the facts (input + parsed output); the
 * parser side knows how to turn it into a corpus row and a fix.
 */
const buildParseReport = (args: {
  rawLine: string;
  name: string;
  amounts: Amount[];
  modifier?: string | null;
}): string => {
  const amounts = JSON.stringify(
    args.amounts.map((a) => ({ unit: a.unit, value: a.value })),
  );
  return [
    "Ingredient parse from cubby (raw line + how it parsed):",
    "",
    `raw:      ${args.rawLine}`,
    `name:     ${args.name}`,
    `amounts:  ${amounts}`,
    `modifier: ${args.modifier ?? "(none)"}`,
  ].join("\n");
};

export function CopyCorpusButton(props: {
  rawLine: string;
  name: string;
  amounts: Amount[];
  modifier?: string | null;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-5 gap-1 px-1 text-muted-foreground/60 text-xs hover:text-foreground"
      title="Copy the raw line + cubby's parse (for an ingredient-parser session)"
      onClick={async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(buildParseReport(props));
          setCopied(true);
          toast.success("Copied raw line + parse");
          setTimeout(() => setCopied(false), 1500);
        } catch {
          toast.error("Copy failed");
        }
      }}
    >
      {copied ? (
        <Check className="h-3 w-3" />
      ) : (
        <ClipboardCopy className="h-3 w-3" />
      )}
      copy parse
    </Button>
  );
}
