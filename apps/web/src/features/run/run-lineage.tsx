import { type RunOut } from "@cubby/schemas/entities/run";
import { ACTIVE_RUN_STATUSES } from "@cubby/shared/client-constants";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import type { RunDetail } from "~/contracts/run.contract";
import { fieldEnumOptions } from "~/entity/display/enum-field-display";
import { useEntityMetadata } from "~/entity/metadata";
import { runHref } from "~/entity/routing/purchase-import-links";
import { run as runOperations } from "~/integrations/tanstack-query/generated/domains/run.gen";
import { Row } from "~/ui/layout";
import { EnumPill } from "~/ui/primitives/enum-pill";

import { runHasAgent, useAgentReviewSync } from "./agent-observation";

const ACTIVE_STATUSES = new Set<string>(ACTIVE_RUN_STATUSES);

/** Shared live Run read for detail slots and pointers to continued work. */
export function useRun(runId: RunOut["id"]) {
  const [agentLive, setAgentLive] = useState(false);
  const query = useQuery({
    ...runOperations.work.queryOptions({ runId }),
    refetchInterval: (current) =>
      current.state.data && ACTIVE_STATUSES.has(current.state.data.status)
        ? agentLive
          ? 30_000
          : 3_000
        : false,
  });
  const live = useAgentReviewSync(
    query.data?.publicId ?? "",
    Boolean(
      query.data &&
      ACTIVE_STATUSES.has(query.data.status) &&
      runHasAgent(query.data),
    ),
  );
  useEffect(() => setAgentLive(live), [live]);
  return query;
}

export function RunLink({
  label,
  publicId,
  status,
}: {
  label: string;
  publicId: string;
  status?: RunDetail["status"];
}) {
  const queryClient = useQueryClient();
  useEntityMetadata("run");
  const statusOptions = useMemo(
    () => fieldEnumOptions(queryClient, "run", "status"),
    [queryClient],
  );
  const option = status
    ? statusOptions.find((entry) => entry.value === status)
    : undefined;
  return (
    <Row wrap gap="sm" align="center" justify="between" className="text-sm">
      <span className="text-muted-foreground">{label}</span>
      <Row wrap gap="sm" align="center">
        <a
          className="inline-flex items-center gap-1 font-mono text-xs text-primary hover:underline"
          href={runHref(publicId)}
          aria-label={`${label} ${publicId}`}
        >
          {publicId}
          <ArrowSquareOutIcon className="size-3" />
        </a>
        {status ? (
          <EnumPill {...option}>{option?.label ?? status}</EnumPill>
        ) : null}
      </Row>
    </Row>
  );
}
