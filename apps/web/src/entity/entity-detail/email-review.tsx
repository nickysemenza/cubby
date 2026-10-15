import type { MailTriagePreviewInput } from "@cubby/schemas/mailbox-research";
import { MAILBOX_CLASSIFICATION_LABEL } from "@cubby/schemas/mailbox-research";
import { supportedDecisionModelSchema } from "@cubby/shared/ai/models";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { purchaseImport } from "~/integrations/tanstack-query/generated/catalog.gen";
import { formatSmallCurrency } from "~/lib/utils";
import { Picker } from "~/ui/combobox/picker";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { useHydrated } from "~/ui/hooks/useHydrated";
import { Button } from "~/ui/primitives/button";

import type { DetailRecordOf } from "./detail-record";
import { EntityReportSlot } from "./report-slot";

const models = [
  { value: "live", label: "Live model split" },
  ...supportedDecisionModelSchema.options.map((value) => ({
    value,
    label: value,
  })),
];

/** Explicit previews use the same read operation as MCP; no automatic inference. */
export function EmailReview({ record }: { record: DetailRecordOf<"email"> }) {
  const hydrated = useHydrated();
  const client = useQueryClient();
  const [model, setModel] = useState("live");
  const preview = useMutation({
    mutationFn: (input: MailTriagePreviewInput) =>
      client.fetchQuery({
        ...purchaseImport.mailTriagePreview.queryOptions(input),
        staleTime: 0,
        gcTime: 0,
        retry: false,
      }),
    retry: false,
  });
  const isForRecord =
    preview.variables?.mailboxId === record.mailboxId &&
    preview.variables.messageId === record.messageId;
  const result = isForRecord ? preview.data : undefined;
  return (
    <div className="space-y-3">
      {record.ownedByViewer && record.provider === "gmail" && (
        <section aria-label="Classification preview" className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Picker
              mode="choose"
              label="Preview decision model"
              options={models}
              value={model}
              onValueChange={(value) => setModel(value ?? "live")}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={!hydrated || preview.isPending}
              onClick={() =>
                preview.mutate({
                  mailboxId: record.mailboxId,
                  messageId: record.messageId,
                  decisionModel:
                    model === "live"
                      ? undefined
                      : supportedDecisionModelSchema.parse(model),
                })
              }
            >
              {preview.isPending
                ? "Previewing classification…"
                : "Preview classification"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Refetches the Gmail original and runs the current classifier,
            including Luna when needed. Does not apply the result.
          </p>
          {isForRecord && preview.error && (
            <ErrorDisplay error={preview.error} />
          )}
          {result && !preview.isPending && (
            <div aria-live="polite" className="space-y-1 text-sm">
              <p>
                {MAILBOX_CLASSIFICATION_LABEL[result.classification]} ·{" "}
                {result.model ?? result.stage}
              </p>
              <details className="text-xs text-muted-foreground">
                <summary>Technical details</summary>
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 py-2">
                  <dt>Classification reason</dt>
                  <dd className="min-w-0 break-words">{result.reason}</dd>
                  <dt>Decision model</dt>
                  <dd>
                    {result.triage.model ?? "No model call"}:{" "}
                    {result.triage.classification}
                  </dd>
                  <dt>Decision view</dt>
                  <dd>
                    {result.view
                      ? `${result.view.bytes} bytes; ${result.view.incompleteReasons.join(", ") || "complete"}`
                      : "Unavailable"}
                  </dd>
                  <dt>Luna fallback</dt>
                  <dd>
                    {result.relevance
                      ? `${result.imageEvidence?.rawClassification ?? "No model call"} → ${result.relevance.classification}`
                      : "Not needed"}
                  </dd>
                  {result.imageEvidence && (
                    <>
                      <dt>Image evidence</dt>
                      <dd>
                        {result.imageEvidence.supplied}/
                        {result.imageEvidence.candidates} images supplied;{" "}
                        {result.imageEvidence.sourceBytes} source bytes;{" "}
                        {result.imageEvidence.requestBytes} request bytes
                      </dd>
                      <dt>Readability</dt>
                      <dd>
                        {result.imageEvidence.imageReadability ??
                          "Not reported"}
                        ;{" "}
                        {result.imageEvidence.complete
                          ? "complete evidence"
                          : "omitted evidence"}
                        ; detail retry{" "}
                        {result.imageEvidence.detailRetried
                          ? "used"
                          : "not used"}
                      </dd>
                      <dt>Image diagnostics</dt>
                      <dd>
                        {result.imageEvidence.failures.join("; ") || "None"}
                      </dd>
                    </>
                  )}
                  <dt>Model calls / elapsed</dt>
                  <dd>
                    {result.usage.calls} / {result.usage.elapsedMs} ms
                  </dd>
                  <dt>Catalog / charged cost</dt>
                  <dd>
                    {result.usage.standardCost === null
                      ? "Unknown"
                      : formatSmallCurrency(result.usage.standardCost)}{" "}
                    /{" "}
                    {result.usage.chargedCost === null
                      ? "Unknown"
                      : formatSmallCurrency(result.usage.chargedCost)}
                    {result.usage.accountingPending && " (accounting pending)"}
                  </dd>
                  <dt>Diagnostic Run</dt>
                  <dd>{result.runId}</dd>
                </dl>
              </details>
            </div>
          )}
        </section>
      )}
      <EntityReportSlot slot="email.review" id={record.id} record={record} />
    </div>
  );
}
