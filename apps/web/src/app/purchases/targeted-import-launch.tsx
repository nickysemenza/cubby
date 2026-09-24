import { CheckCircleIcon as CheckCircle2 } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { SparkleIcon as Sparkles } from "@phosphor-icons/react/dist/csr/Sparkle";
import { WarningCircleIcon as CircleAlert } from "@phosphor-icons/react/dist/csr/WarningCircle";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { importRunHref } from "~/app/purchases/purchase-import-links";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { StatusText } from "~/components/ui/status-text";
import {
  loadTargetedImportLaunch,
  startTargetedImport,
  type TargetedImportPurpose,
  type TargetedProductCandidate,
  type TargetedImportSource,
} from "~/lib/targeted-import-api";

export function TargetedImportLaunchButton({
  targetId,
  targetLabel,
  purpose,
}: {
  targetId: string;
  targetLabel: string;
  purpose: TargetedImportPurpose;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => setOpen(true)}
      >
        {purpose === "purchase_validation" ? <CheckCircle2 /> : <Sparkles />}
        {purpose === "purchase_validation"
          ? "Validate ingestion"
          : "Enrich product"}
      </Button>
      <TargetedImportLaunchDialog
        open={open}
        onOpenChange={setOpen}
        targetId={targetId}
        targetLabel={targetLabel}
        purpose={purpose}
      />
    </>
  );
}

export function TargetedProductBulkEnrichmentDialog({
  open,
  onOpenChange,
  products,
  onFinished,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  products: Array<{ id: string; name: string }>;
  onFinished: (success: boolean) => void;
}) {
  const launch = useQuery({
    queryKey: [
      "targeted-import",
      "bulk-enrichment",
      products.map(({ id }) => id),
    ],
    queryFn: async () =>
      await Promise.all(
        products.map(({ id }) =>
          loadTargetedImportLaunch("product_enrichment", id),
        ),
      ),
    enabled: open && products.length > 0,
  });
  const [targets, setTargets] = useState<TargetedProductCandidate[]>([]);
  useEffect(() => {
    if (launch.data)
      setTargets(launch.data.flatMap((result) => result.products));
  }, [launch.data]);
  const selected = targets.filter((target) => target.selected);
  const start = useMutation({
    mutationFn: () =>
      startTargetedImport({
        purpose: "product_enrichment",
        targets: selected.map((target) => ({
          productId: target.productId,
          sourceId: target.sourceId,
          vendorAccountId: target.vendorAccountId,
        })),
      }),
    onSuccess: (result) => {
      const first = result.runs.find(
        (entry) => entry.created && entry.run,
      )?.run;
      onFinished(true);
      if (first) window.location.assign(importRunHref(first.id));
    },
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Enrich selected products</DialogTitle>
          <DialogDescription>
            Products are split into independent account runs. Busy accounts are
            refused with their blocking run.
          </DialogDescription>
        </DialogHeader>
        {launch.isPending ? (
          <StatusText>Loading verified sources…</StatusText>
        ) : null}
        {launch.isError ? (
          <StatusText tone="destructive">{launch.error.message}</StatusText>
        ) : null}
        {launch.data ? (
          <ProductTargetChecklist targets={targets} onChange={setTargets} />
        ) : null}
        {start.data?.runs
          .flatMap((entry) => (entry.blockingRun ? [entry.blockingRun] : []))
          .map((run) => (
            <a
              key={run.id}
              href={importRunHref(run.id)}
              className="text-sm text-primary hover:underline"
            >
              Open blocking run {run.id}
            </a>
          ))}
        {start.isError ? (
          <StatusText tone="destructive">{start.error.message}</StatusText>
        ) : null}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              onOpenChange(false);
              onFinished(false);
            }}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={selected.length === 0 || start.isPending}
            onClick={() => start.mutate()}
          >
            Start enrichment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// eslint-disable-next-line complexity -- The dialog renders two purpose-specific launch forms behind one shared admission surface.
export function TargetedImportLaunchDialog({
  open,
  onOpenChange,
  targetId,
  targetLabel,
  purpose,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  targetId: string;
  targetLabel: string;
  purpose: TargetedImportPurpose;
}) {
  const launch = useQuery({
    queryKey: ["targeted-import", "launch", purpose, targetId],
    queryFn: () => loadTargetedImportLaunch(purpose, targetId),
    enabled: open,
  });
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [targets, setTargets] = useState<TargetedProductCandidate[]>([]);
  const start = useMutation({
    mutationFn: async () => {
      if (purpose === "purchase_validation") {
        return await startTargetedImport({
          purpose,
          purchaseId: targetId,
          sourceId,
        });
      }
      return await startTargetedImport({
        purpose,
        targets: targets
          .filter((target) => target.selected)
          .map((target) => ({
            productId: target.productId,
            sourceId: target.sourceId,
            vendorAccountId: target.vendorAccountId,
          })),
      });
    },
    onSuccess: (result) => {
      const run = result.runs.find((entry) => entry.created && entry.run)?.run;
      if (run) window.location.assign(importRunHref(run.id));
    },
  });

  useEffect(() => {
    if (!launch.data) return;
    if (purpose === "purchase_validation") {
      setSourceId(
        launch.data.purchase?.sources.find((source) => source.default)?.id ??
          launch.data.purchase?.sources.find((source) => source.usable)?.id ??
          null,
      );
      return;
    }
    setTargets(launch.data.products);
  }, [launch.data, purpose]);

  const selectedTargets = targets.filter((target) => target.selected);
  const canStart =
    purpose === "purchase_validation"
      ? (launch.data?.purchase?.canValidate ?? false)
      : selectedTargets.length > 0 &&
        selectedTargets.every(
          (target) => !target.needsAccountChoice || target.vendorAccountId,
        );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>
            {purpose === "purchase_validation"
              ? `Validate ingestion for ${targetLabel}`
              : `Enrich ${targetLabel}`}
          </DialogTitle>
          <DialogDescription>
            {purpose === "purchase_validation"
              ? "Replay the chosen evidence without changing the purchase. A difference is recorded for review."
              : "Only the listed empty fields can be filled. Existing product values remain untouched unless separately approved."}
          </DialogDescription>
        </DialogHeader>
        {launch.isPending ? (
          <StatusText>Loading import options…</StatusText>
        ) : null}
        {launch.isError ? (
          <StatusText tone="destructive">{launch.error.message}</StatusText>
        ) : null}
        {launch.data && purpose === "purchase_validation" ? (
          <PurchaseValidationSourcePicker
            sources={launch.data.purchase?.sources ?? []}
            disabled={!launch.data.purchase?.canValidate}
            reason={launch.data.purchase?.reason ?? null}
            selectedId={sourceId}
            onSelect={setSourceId}
          />
        ) : null}
        {launch.data && purpose === "product_enrichment" ? (
          <ProductTargetChecklist targets={targets} onChange={setTargets} />
        ) : null}
        {start.data?.runs.some((entry) => entry.blockingRun) ? (
          <div className="grid gap-1 border border-border bg-muted/30 p-3 text-sm">
            <div className="flex items-center gap-2 font-medium">
              <CircleAlert className="size-3.5 text-warning" />
              One account is already busy
            </div>
            {start.data.runs
              .flatMap((entry) =>
                entry.blockingRun ? [entry.blockingRun] : [],
              )
              .map((run) => (
                <a
                  key={run.id}
                  className="w-fit text-primary hover:underline"
                  href={importRunHref(run.id)}
                >
                  Open {run.id} ({run.status})
                </a>
              ))}
          </div>
        ) : null}
        {start.isError ? (
          <StatusText tone="destructive">{start.error.message}</StatusText>
        ) : null}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!canStart || start.isPending}
            onClick={() => start.mutate()}
          >
            {purpose === "purchase_validation"
              ? "Start validation"
              : "Start enrichment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PurchaseValidationSourcePicker({
  sources,
  disabled,
  reason,
  selectedId,
  onSelect,
}: {
  sources: TargetedImportSource[];
  disabled: boolean;
  reason: string | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  if (disabled)
    return (
      <StatusText tone="warning">
        {reason ?? "Validation is not available for this purchase."}
      </StatusText>
    );
  if (sources.length === 0)
    return (
      <StatusText tone="warning">
        No replayable evidence was found. Upload evidence or record that it is
        unavailable.
      </StatusText>
    );
  return (
    <fieldset className="grid gap-2">
      <legend className="font-medium">Evidence to replay</legend>
      {sources.map((source) => (
        <label
          key={source.id}
          aria-label={source.label}
          className="flex min-h-11 items-start gap-2 border border-border p-3 text-sm"
        >
          <input
            type="radio"
            name="targeted-import-source"
            value={source.id}
            checked={selectedId === source.id}
            disabled={!source.usable}
            onChange={() => onSelect(source.id)}
          />
          <span className="grid gap-0.5">
            <span className="font-medium">{source.label}</span>
            <span className="text-xs text-muted-foreground">
              {source.kind}
              {source.vendorAccountLabel
                ? ` · ${source.vendorAccountLabel}`
                : ""}
              {source.reason ? ` · ${source.reason}` : ""}
            </span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

function ProductTargetChecklist({
  targets,
  onChange,
}: {
  targets: TargetedProductCandidate[];
  onChange: (targets: TargetedProductCandidate[]) => void;
}) {
  if (targets.length === 0)
    return <StatusText>No products are available for enrichment.</StatusText>;
  return (
    <div className="grid gap-2" aria-label="Products to enrich">
      {targets.map((target) => (
        <label
          key={target.productId}
          className="grid gap-2 border border-border p-3 text-sm sm:grid-cols-[auto_minmax(0,1fr)_12rem] sm:items-center"
        >
          <input
            type="checkbox"
            checked={target.selected}
            onChange={(event) =>
              onChange(
                targets.map((candidate) =>
                  candidate.productId === target.productId
                    ? { ...candidate, selected: event.target.checked }
                    : candidate,
                ),
              )
            }
          />
          <span className="grid gap-0.5">
            <span className="font-medium">{target.productName}</span>
            <span className="text-xs text-muted-foreground">
              {target.sourceLabel ??
                target.reason ??
                "Choose a verified source"}
            </span>
          </span>
          {target.needsAccountChoice ? (
            <Input
              aria-label={`Account for ${target.productName}`}
              list={`targeted-account-options-${target.productId}`}
              value={target.vendorAccountLabel ?? ""}
              placeholder="Choose account"
              onChange={(event) => {
                const account = target.accountChoices.find(
                  (choice) => choice.label === event.target.value,
                );
                onChange(
                  targets.map((candidate) =>
                    candidate.productId === target.productId
                      ? {
                          ...candidate,
                          vendorAccountId: account?.id ?? null,
                          vendorAccountLabel:
                            account?.label ?? (event.target.value || null),
                        }
                      : candidate,
                  ),
                );
              }}
            />
          ) : (
            <span className="text-xs text-muted-foreground">
              {target.vendorAccountLabel ?? "No browser account"}
            </span>
          )}
          {target.needsAccountChoice ? (
            <datalist id={`targeted-account-options-${target.productId}`}>
              {target.accountChoices.map((account) => (
                <option key={account.id} value={account.label}>
                  {account.label}
                </option>
              ))}
            </datalist>
          ) : null}
        </label>
      ))}
    </div>
  );
}
