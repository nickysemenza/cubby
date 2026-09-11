import { useState } from "react";

import { VerbButton } from "~/app/_components/actions/action-verb-ui";
import { verbDef } from "~/app/_components/actions/action-verbs";
import { AiProvenance } from "~/app/_components/ai/ai-proposal-card";
import { AiProposalList } from "~/app/_components/ai/ai-proposal-list";
import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import { Row, Stack } from "~/components/layout";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { Description } from "~/components/ui/description";
import { ai } from "~/lib/ai.functions";

/**
 * Where the product category list is failing the catalog.
 *
 * The audit is advisory by construction: product categories are a fixed enum
 * in `@cubby/shared` (`productCategoryValues`), so there is no "create
 * category" the app can run — adding one is a schema change plus a colour
 * token. What the surface owes instead is a way to *clear* a suggestion you
 * have read and decided against, which it had none of: every run redisplayed
 * the same twelve observations with no way to work through them. Dismiss is
 * session-local, matching the audit itself, which is re-run on demand rather
 * than stored.
 */
export function CategoryAudit() {
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const [ranAt, setRanAt] = useState<Date | null>(null);

  const auditMutation = useActionMutation({
    mutationFn: ai.auditCategories.mutationOptions,
    onSuccess: () => {
      setDismissed(new Set());
      setRanAt(new Date());
    },
  });

  const result = auditMutation.data;
  const suggestions = (result?.suggestions ?? []).filter(
    (suggestion) => !dismissed.has(suggestion.categoryName),
  );

  return (
    <Card>
      <CardHeader>
        <Row align="center" justify="between" gap="sm" wrap>
          <Stack gap="xs">
            <CardTitle icon={verbDef("analyze").icon}>Category audit</CardTitle>
            <CardDescription>
              Gaps in the category system, read from the current product
              catalog.
            </CardDescription>
          </Stack>
          <VerbButton
            verb="analyze"
            object="categories"
            variant="default"
            size="default"
            pending={auditMutation.isPending}
            className="min-h-9 max-sm:min-h-11"
            onClick={() => auditMutation.mutate(undefined)}
          />
        </Row>
      </CardHeader>

      {result && (
        <CardContent>
          <Stack>
            <Description>{result.summary}</Description>

            <AiProposalList
              heading="Suggested categories"
              provenance={<AiProvenance analyzedAt={ranAt} />}
              rows={suggestions.map((suggestion) => ({
                id: suggestion.categoryName,
                title: suggestion.categoryName,
                meta: suggestion.description,
                reasoning: [
                  suggestion.reasoning,
                  suggestion.productNames.length > 0
                    ? `Products: ${suggestion.productNames.join(", ")}`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · "),
              }))}
              rejectLabel="Dismiss"
              rejectAllLabel="Dismiss all"
              onReject={(id) => setDismissed((prev) => new Set(prev).add(id))}
              footer={
                <Description size="2xs">
                  Categories are a fixed list in the product schema
                  (`productCategoryValues` in `@cubby/shared`); adding one is a
                  code change, so these are observations to act on there rather
                  than records to create here.
                </Description>
              }
            />
          </Stack>
        </CardContent>
      )}
    </Card>
  );
}
