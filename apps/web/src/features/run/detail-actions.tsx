import type { DetailSlotComponent } from "~/entity/entity-detail/detail-slots";
import {
  ReportDetailActions,
  RunSentryAction,
} from "~/entity/entity-detail/report-slot";
import { RunAgentActions } from "~/features/purchase/purchase-import-run-detail";

/** The Run header: live-progress commands, the import agent's controls and its Sentry link. */
export const RunDetailActions: DetailSlotComponent<"run"> = ({ record }) => (
  <>
    <ReportDetailActions
      slot="run.live-progress"
      id={record.id}
      status={record.status}
    />
    <RunAgentActions record={record} />
    <RunSentryAction error={record.dispatchError} />
  </>
);
