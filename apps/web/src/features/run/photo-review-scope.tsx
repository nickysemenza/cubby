import type { PhotoGroupProposal } from "@cubby/schemas/photo-import-run";
import { useMemo, useState } from "react";

import { Row } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";
import { Input } from "~/ui/primitives/input";

const EMPTY: readonly PhotoGroupProposal[] = [];
type ReviewScope = {
  ids: string[];
  attentionIds: string[];
  attention: boolean;
};

/** Admission and attention membership stay fixed while live values refresh. */
export function usePhotoReviewScope({
  proposals,
  getName,
}: {
  proposals: readonly PhotoGroupProposal[] | undefined;
  getName: (proposal: PhotoGroupProposal) => string;
}) {
  const [scope, setScope] = useState<ReviewScope | null>(null);
  const [search, setSearch] = useState("");
  if (proposals && scope === null) {
    const attentionIds = proposals
      .filter((item) => item.state === "proposed")
      .map((item) => item.groupKey);
    setScope({
      ids: proposals.map((item) => item.groupKey),
      attentionIds,
      attention: attentionIds.length > 0,
    });
  }
  const rows = proposals ?? EMPTY;
  const groups = useMemo(() => {
    const byKey = new Map(rows.map((item) => [item.groupKey, item]));
    const admitted = (scope?.ids ?? []).flatMap((id) => {
      const item = byKey.get(id);
      return item ? [item] : [];
    });
    const text = search.trim().toLowerCase();
    const visible = admitted.filter(
      (item) =>
        (!scope?.attention || scope.attentionIds.includes(item.groupKey)) &&
        (!text ||
          `${getName(item)} ${item.blockedReason ?? ""} ${item.state}`
            .toLowerCase()
            .includes(text)),
    );
    return {
      admitted,
      visible,
      arrivals: rows.filter((item) => !scope?.ids.includes(item.groupKey)),
      ready: rows.filter(
        (item) => item.state === "proposed" && !item.blockedReason,
      ),
      filteredReady: visible.filter(
        (item) => item.state === "proposed" && !item.blockedReason,
      ),
    };
  }, [rows, scope, search, getName]);
  return {
    ...groups,
    scope,
    setScope,
    search,
    setSearch,
    attention: scope?.attention ?? false,
    total: rows.length,
    attentionCount: rows.filter((item) => item.state === "proposed").length,
  };
}

export function PhotoReviewScopeControls({
  review,
}: {
  review: ReturnType<typeof usePhotoReviewScope>;
}) {
  return (
    <Row wrap gap="sm">
      <Button
        aria-pressed={review.scope?.attention ?? false}
        variant={review.scope?.attention ? "secondary" : "ghost"}
        onClick={() =>
          review.setScope((current) =>
            current
              ? {
                  ...current,
                  attention: true,
                  attentionIds: review.admitted
                    .filter((item) => item.state === "proposed")
                    .map((item) => item.groupKey),
                }
              : current,
          )
        }
      >
        Needs attention · {review.attentionCount}
      </Button>
      <Button
        aria-pressed={!review.scope?.attention}
        variant={!review.scope?.attention ? "secondary" : "ghost"}
        onClick={() =>
          review.setScope((current) =>
            current ? { ...current, attention: false } : current,
          )
        }
      >
        Results · {review.total}
      </Button>
      <Input
        aria-label="Search photo groups"
        placeholder="Search photo groups"
        value={review.search}
        onChange={(event) => review.setSearch(event.target.value)}
        className="max-w-sm"
      />
      {review.arrivals.length ? (
        <Button
          variant="outline"
          onClick={() =>
            review.setScope((current) =>
              current
                ? {
                    ...current,
                    ids: [
                      ...current.ids,
                      ...review.arrivals.map((item) => item.groupKey),
                    ],
                    attentionIds: [
                      ...current.attentionIds,
                      ...review.arrivals
                        .filter((item) => item.state === "proposed")
                        .map((item) => item.groupKey),
                    ],
                  }
                : current,
            )
          }
        >
          Show {review.arrivals.length} new items
        </Button>
      ) : null}
    </Row>
  );
}

export function PhotoReviewEmpty({
  total,
  visible,
}: {
  total: number;
  visible: number;
}) {
  if (!total || visible) return null;
  return (
    <p className="text-sm text-muted-foreground">
      No photo groups match this view. Clear search or choose Results.
    </p>
  );
}
