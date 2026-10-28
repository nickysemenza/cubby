import { Link } from "@tanstack/react-router";

import type { DetailSlotComponent } from "~/entity/entity-detail/detail-slots";
import { Button } from "~/ui/primitives/button";

import { RetryJobsButton } from "./retry-jobs";

export const JobDetailActions: DetailSlotComponent<"job"> = ({ record }) => (
  <>
    <Button
      size="sm"
      variant="outline"
      render={<Link to="/runs/types" hash={`job-${record.kind}`} />}
      nativeButton={false}
    >
      What this Job does
    </Button>
    <Button
      size="sm"
      variant="outline"
      render={
        <Link to="/activity" search={{ tab: "now", kind: record.kind }} />
      }
      nativeButton={false}
    >
      Related Jobs
    </Button>
    {record.state === "failed" ||
    record.state === "retry_wait" ||
    record.state === "queued" ? (
      <RetryJobsButton filter={{ codes: [record.id] }} />
    ) : null}
  </>
);
