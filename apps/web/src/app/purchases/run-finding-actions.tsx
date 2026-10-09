import { Link } from "@tanstack/react-router";

import type { RunDetail } from "~/contracts/run.contract";
import { entityDetailLink } from "~/entity/entities";
import { problems as problemOperations } from "~/integrations/tanstack-query/generated/problems.gen";
import { formatCurrency } from "~/lib/utils";
import { useActionMutation } from "~/ui/hooks/useActionMutation";
import { Row, Stack } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";

function canApplyFinding(fix: RunDetail["findings"][number]["proposedFix"]) {
  return (
    fix !== null &&
    !["receive_purchase", "research_field_correction"].includes(fix.kind)
  );
}

export function RunFindingActions({
  finding,
}: {
  finding: Pick<RunDetail["findings"][number], "id" | "proposedFix">;
}) {
  const resolve = useActionMutation({
    mutationFn: problemOperations.resolveRunFinding.mutationOptions,
    success: (result) =>
      result.status === "applied"
        ? "Applied import correction"
        : "Dismissed import finding",
  });
  const correction =
    finding.proposedFix?.kind === "research_field_correction"
      ? finding.proposedFix
      : null;
  const canApply = canApplyFinding(finding.proposedFix);
  const replacement =
    finding.proposedFix?.kind === "replace_aggregate_line"
      ? finding.proposedFix
      : null;
  const snapshot = replacement?.reviewSnapshot;
  const reviewFingerprint =
    finding.proposedFix?.kind === "validation_corrections"
      ? finding.proposedFix.reviewSnapshot.fingerprint
      : snapshot?.fingerprint;
  const reviewLines =
    replacement?.lines.map((line, ordinal) => ({
      ...line,
      reviewKey: `${snapshot?.fingerprint ?? finding.id}/line/${ordinal}`,
    })) ?? [];
  return (
    <Stack gap="sm">
      {replacement ? (
        <Stack gap="tight">
          <p className="text-sm">
            {snapshot
              ? `Replace ${snapshot.title} (${formatCurrency(snapshot.amount)}) with the receipt lines below.`
              : "Receipt replacement needs a fresh server review before it can be applied."}
          </p>
          {snapshot ? (
            <p className="text-xs text-muted-foreground">
              {[
                snapshot.date,
                snapshot.projectName,
                snapshot.categoryName,
                snapshot.costType,
                snapshot.trade,
                snapshot.notes,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          ) : null}
          {reviewLines.map((line) => (
            <div key={line.reviewKey} className="text-sm">
              {line.title} · {formatCurrency(line.amount ?? 0)}
            </div>
          ))}
          {replacement.reviewedLineAttributions?.map((share) => (
            <div
              key={`${share.lineIndex}:${share.role}:${share.partyCode}`}
              className="text-xs text-muted-foreground"
            >
              Line {share.lineIndex + 1} · {share.role} · {share.partyCode} ·{" "}
              {formatCurrency(share.amount)}
            </div>
          ))}
        </Stack>
      ) : null}
      <Row className="gap-2">
        {correction ? (
          <Button
            size="sm"
            nativeButton={false}
            render={<Link {...entityDetailLink("run", correction.runRef)} />}
          >
            Review correction
          </Button>
        ) : null}
        {canApply && (!replacement || snapshot) ? (
          <Button
            size="sm"
            onClick={() =>
              resolve.mutate({
                id: finding.id,
                action: "apply",
                reviewedFingerprint: reviewFingerprint,
              })
            }
            disabled={resolve.isPending}
          >
            {resolve.isPending ? "Applying…" : "Apply fix"}
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          onClick={() => resolve.mutate({ id: finding.id, action: "dismiss" })}
          disabled={resolve.isPending}
        >
          Dismiss
        </Button>
      </Row>
    </Stack>
  );
}
