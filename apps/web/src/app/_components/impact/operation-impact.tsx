import type {
  ImpactItem,
  PreviewDeleteEntity,
  PreviewMergeEntity,
  PreviewOperation,
} from "@cubby/schemas/entity-integrity";
import { previewOperationInputSchema } from "@cubby/schemas/entity-integrity";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  Ban,
  ChevronDown,
  Loader2,
  RotateCw,
} from "lucide-react";
import { useState } from "react";
import { Row, Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "~/components/ui/collapsible";
import { useTRPC } from "~/integrations/trpc/react";

/**
 * Live impact preview for a destructive or merge operation, rendered inside the
 * existing confirmation dialogs.
 *
 * ## Why this does NOT gate confirmation
 *
 * The preview is advisory. The mutation re-checks everything inside its own
 * transaction, so a preview that is slow, stale, or failed outright tells us
 * nothing about whether the mutation would succeed. Blocking the confirm button
 * on it would therefore trade a real capability (deleting a row) for a false
 * sense of safety, and would make a preview outage an outage of every
 * destructive action in the app.
 *
 * So: confirmation stays enabled while this loads, and stays enabled if it
 * errors. The ONE exception is `canProceed === false` — a blocker the server
 * positively identified, which means the mutation is going to throw anyway.
 * Disabling there turns a confusing error toast into an explanation up front.
 *
 * It also replaces hand-written cascade prose with live counts. Static copy
 * ("this will delete every imported recipe") cannot say *how many*, and drifts
 * silently when the cascade changes.
 */

/** Fetch a preview for `input`, only while `enabled` (i.e. the dialog is open). */
export type PreviewOperationDraft =
  | {
      operation: "delete";
      entity: PreviewDeleteEntity;
      ids: string[];
    }
  | {
      operation: "merge";
      entity: PreviewMergeEntity;
      keepId?: string;
      mergeIds: string[];
    };

const DISABLED_PREVIEW_INPUT = previewOperationInputSchema.parse({
  operation: "delete",
  entity: "product",
  ids: ["PRD-2222"],
});

export function useOperationPreview(
  input: PreviewOperationDraft | null,
  enabled: boolean,
) {
  const api = useTRPC();
  const parsedInput = input ? previewOperationInputSchema.parse(input) : null;
  return useQuery({
    ...api.entityIntegrity.previewOperation.queryOptions(
      parsedInput ?? DISABLED_PREVIEW_INPUT,
    ),
    enabled: enabled && parsedInput !== null,
    // Always fresh for the ids at hand: a preview describes current state, and
    // a cached one from a minute ago can be wrong about what is still there.
    staleTime: 0,
    gcTime: 0,
    retry: 1,
  });
}

const EFFECT_TONE: Record<ImpactItem["effect"], string> = {
  block: "text-destructive",
  "hard-delete": "text-destructive",
  "soft-delete": "text-warning",
  detach: "text-warning",
  repoint: "text-foreground",
  "move-dedupe": "text-foreground",
  preserve: "text-muted-foreground",
};

function ImpactRow({
  item,
  detailed = false,
}: {
  item: ImpactItem;
  detailed?: boolean;
}) {
  const targets = Object.entries(item.byTargetId).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return (
    <Stack gap="tight">
      <Row gap="xs" align="baseline" wrap>
        <span
          className={`font-mono text-xs tabular-nums ${EFFECT_TONE[item.effect]}`}
        >
          {item.total}
        </span>
        <span className="text-sm">{item.label}</span>
        <span className="font-mono text-2xs text-slate">{item.code}</span>
      </Row>
      {detailed && (
        <Stack gap="tight" className="pl-4">
          <span className="text-muted-foreground text-xs">
            {item.description}
          </span>
          {targets.length > 0 && (
            <span className="font-mono text-2xs text-slate">
              {targets.map(([id, count]) => `${id} × ${count}`).join(" · ")}
            </span>
          )}
        </Stack>
      )}
    </Stack>
  );
}

function Section({
  title,
  items,
  tone,
  detailed = false,
}: {
  title: string;
  items: ImpactItem[];
  tone?: "destructive";
  detailed?: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <Stack gap="tight">
      <Row gap="xs" align="center">
        {tone === "destructive" && (
          <Ban className="size-3.5 text-destructive" aria-hidden />
        )}
        <span
          className={`font-mono text-2xs uppercase tracking-wider ${
            tone === "destructive" ? "text-destructive" : "text-slate"
          }`}
        >
          {title}
        </span>
      </Row>
      {items.map((item) => (
        <ImpactRow
          key={`${item.code}-${item.edgeKey ?? item.label}`}
          item={item}
          detailed={detailed}
        />
      ))}
    </Stack>
  );
}

export function OperationImpact({
  preview,
  isLoading,
  isError,
  onRetry,
}: {
  preview: PreviewOperation | undefined;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
}) {
  const [ledgerOpen, setLedgerOpen] = useState(false);

  if (isLoading) {
    return (
      <Row gap="xs" align="center" className="text-muted-foreground text-sm">
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
        Checking what this will affect…
      </Row>
    );
  }

  if (isError || !preview) {
    return (
      <Row gap="sm" align="center" className="text-muted-foreground text-sm">
        <AlertTriangle className="size-3.5 text-warning" aria-hidden />
        {/* Deliberately not alarming: the action itself is still available, and
            the mutation does its own checking. This is lost information, not a
            lost capability. */}
        <span>Couldn&apos;t load the impact preview.</span>
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RotateCw className="size-3.5" aria-hidden />
          Retry
        </Button>
      </Row>
    );
  }

  const nothing =
    preview.blockers.length === 0 &&
    preview.changes.length === 0 &&
    preview.sideEffects.length === 0;
  const risks = preview.changes.filter((item) =>
    ["hard-delete", "soft-delete", "detach", "move-dedupe"].includes(
      item.effect,
    ),
  );
  const ledgerSize = preview.changes.length + preview.sideEffects.length;

  return (
    <Stack gap="sm" className="border-[var(--border)] border-y py-2">
      {!preview.canProceed && (
        <Row gap="xs" align="center">
          <Badge variant="destructive">Blocked</Badge>
          <span className="text-sm">
            This can&apos;t be completed while the following exist.
          </span>
        </Row>
      )}
      <Section title="Blocked by" items={preview.blockers} tone="destructive" />
      <Section title="Needs attention" items={risks} />
      {ledgerSize > 0 && (
        <Collapsible open={ledgerOpen} onOpenChange={setLedgerOpen}>
          <CollapsibleTrigger className="flex w-full items-center justify-between border-border border-t pt-2 text-left">
            <span className="font-mono text-2xs text-slate uppercase tracking-wider">
              Complete consequence ledger ({ledgerSize})
            </span>
            <ChevronDown
              className={`size-3.5 text-slate transition-transform ${ledgerOpen ? "rotate-180" : ""}`}
              aria-hidden
            />
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-2">
            <Stack gap="sm">
              <Section title="Will change" items={preview.changes} detailed />
              <Section
                title="Side effects"
                items={preview.sideEffects}
                detailed
              />
            </Stack>
          </CollapsibleContent>
        </Collapsible>
      )}
      {nothing && (
        <span className="text-muted-foreground text-sm">
          Nothing else references {preview.targetCount === 1 ? "this" : "these"}
          .
        </span>
      )}
    </Stack>
  );
}
