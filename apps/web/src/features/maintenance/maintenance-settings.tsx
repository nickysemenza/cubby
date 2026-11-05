import { RUN_KINDS } from "@cubby/schemas/run-fields";
import { useLocation } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { MaintenanceRunCard } from "~/features/maintenance/maintenance-run-card";
import { MaintenanceTools } from "~/features/maintenance/maintenance-tools";
import { DefinedRunSteps, WorkEffects } from "~/features/run/work-definition";
import { Section, Stack } from "~/ui/layout";
import { Disclosure } from "~/ui/layout/disclosure";

/**
 * Operator controls, closed until asked for: a closed panel mounts nothing, so
 * opening Settings reads no maintenance status. Old Work links land here open.
 */
export function MaintenanceSettings() {
  const hash = useLocation({ select: (location) => location.hash });
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (hash === "maintenance") setOpen(true);
  }, [hash]);
  return (
    <Disclosure
      summary="Daily pass and repair tools"
      open={open}
      onOpenChange={setOpen}
    >
      <Stack gap="lg" className="pt-3">
        <Section
          headingAs="h3"
          title="Daily maintenance"
          caption="Daily at 7 a.m. America/Los_Angeles, following daylight saving time. Each step is recorded in a Run."
        >
          <Stack gap="md">
            <WorkEffects explanation={RUN_KINDS.maintenance.explanation} />
            <Disclosure summary="The maintenance pass, step by step">
              <DefinedRunSteps kind={RUN_KINDS.maintenance} />
            </Disclosure>
            <MaintenanceRunCard />
          </Stack>
        </Section>
        <Section
          headingAs="h3"
          title="Repair tools"
          caption="Occasional repairs. Each command owns its scope and effects; previews inspect current candidates."
        >
          <MaintenanceTools />
        </Section>
      </Stack>
    </Disclosure>
  );
}
