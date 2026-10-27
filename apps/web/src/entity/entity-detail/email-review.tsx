import { fieldValueOf } from "@cubby/schemas/field-envelope";
import type { MailTriagePreviewInput } from "@cubby/schemas/mailbox-research";
import { MAILBOX_CLASSIFICATION_LABEL } from "@cubby/schemas/mailbox-research";
import { supportedDecisionModelSchema } from "@cubby/shared/ai/models";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { purchaseImport } from "~/integrations/tanstack-query/generated/catalog/purchaseImport.gen";
import { formatSmallCurrency } from "~/lib/number-format";
import { Picker } from "~/ui/combobox/picker";
import { Facts, FactsDensityProvider } from "~/ui/common/facts";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { useHydrated } from "~/ui/hooks/use-hydrated";
import { Disclosure } from "~/ui/layout/disclosure";
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
  const effectiveRecordOwnedByViewer = fieldValueOf(
    record.fields.ownedByViewer,
  );

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
      {effectiveRecordOwnedByViewer && record.provider === "gmail" && (
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
              <Disclosure summary="Technical details" className="text-xs">
                <FactsDensityProvider density="compact">
                  <Facts
                    layout="list"
                    className="pb-2"
                    facts={[
                      {
                        label: "Classification reason",
                        value: result.reason,
                      },
                      {
                        label: "Decision model",
                        value: `${result.triage.model ?? "No model call"}: ${result.triage.classification}`,
                      },
                      {
                        label: "Decision view",
                        value: result.view
                          ? `${result.view.bytes} bytes; ${result.view.incompleteReasons.join(", ") || "complete"}`
                          : "Unavailable",
                      },
                      {
                        label: "Luna fallback",
                        value: result.relevance
                          ? `${result.imageEvidence?.rawClassification ?? "No model call"} → ${result.relevance.classification}`
                          : "Not needed",
                      },
                      ...(result.imageEvidence
                        ? [
                            {
                              label: "Image evidence",
                              value: `${result.imageEvidence.supplied}/${result.imageEvidence.candidates} images supplied; ${result.imageEvidence.sourceBytes} source bytes; ${result.imageEvidence.requestBytes} request bytes`,
                            },
                            {
                              label: "Readability",
                              value: `${result.imageEvidence.imageReadability ?? "Not reported"}; ${result.imageEvidence.complete ? "complete evidence" : "omitted evidence"}; detail retry ${result.imageEvidence.detailRetried ? "used" : "not used"}`,
                            },
                            {
                              label: "Image diagnostics",
                              value:
                                result.imageEvidence.failures.join("; ") ||
                                "None",
                            },
                          ]
                        : []),
                      {
                        label: "Model calls / elapsed",
                        value: `${result.usage.calls} / ${result.usage.elapsedMs} ms`,
                      },
                      {
                        label: "Catalog / charged cost",
                        value: `${result.usage.standardCost === null ? "Unknown" : formatSmallCurrency(result.usage.standardCost)} / ${result.usage.chargedCost === null ? "Unknown" : formatSmallCurrency(result.usage.chargedCost)}${result.usage.accountingPending ? " (accounting pending)" : ""}`,
                      },
                      {
                        label: "Diagnostic Run",
                        value: (
                          <EntityRefLink
                            entity="run"
                            id={result.runId}
                            name={result.runId}
                          />
                        ),
                      },
                    ]}
                  />
                </FactsDensityProvider>
              </Disclosure>
            </div>
          )}
        </section>
      )}
      <EntityReportSlot slot="email.review" id={record.id} record={record} />
    </div>
  );
}
