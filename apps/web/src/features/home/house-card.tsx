import { HammerIcon } from "@phosphor-icons/react/dist/csr/Hammer";
import { Link } from "@tanstack/react-router";

import { CollectionReportSlot } from "~/entity/entity-detail/report-slot";
import { Section } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";

export function TodayAttention() {
  return (
    <Section
      title="Next up"
      icon={<HammerIcon />}
      description="Unblocked household work, in its existing priority order."
      actions={
        <Button
          render={<Link to="/tasks" search={{ view: "agenda" }} />}
          nativeButton={false}
          variant="ghost"
          size="sm"
        >
          All tasks
        </Button>
      }
    >
      <CollectionReportSlot
        slot="task.briefing"
        scope={{ kind: "list", entity: "task", filters: {} }}
      />
    </Section>
  );
}
