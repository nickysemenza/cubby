import { Link } from "@tanstack/react-router";

import type { DetailSlotComponent } from "~/entity/entity-detail/detail-slots";
import {
  ReportDetailActions,
  RunSentryAction,
} from "~/entity/entity-detail/report-slot";
import { RunAgentActions } from "~/features/purchase/purchase-import-run-detail";
import { Button } from "~/ui/primitives/button";

/** The Run header: live-progress commands, the import agent's controls and its Sentry link. */
export const RunDetailActions: DetailSlotComponent<"run"> = ({ record }) => (
  <>
    <Button
      size="sm"
      variant="outline"
      render={<Link to="/runs/types" hash={record.purpose} />}
      nativeButton={false}
    >
      What this Run does
    </Button>
    <ReportDetailActions
      slot="run.live-progress"
      id={record.id}
      status={record.status}
    />
    <RunAgentActions record={record} />
    <RunSentryAction error={record.dispatchError} />
  </>
);
