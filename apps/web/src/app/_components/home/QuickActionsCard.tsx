import { LightningIcon as Zap } from "@phosphor-icons/react/dist/csr/Lightning";
import { Link } from "@tanstack/react-router";
import { useId } from "react";

import { Grid, Row } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { EntityIcon, entities } from "~/entities/entities";

import { actionsForSurface } from "../actions/action-items";

const homeActions = actionsForSurface("home-quick");

/**
 * Quick actions for the home page, drawn from the `home-quick` slice of the
 * canonical registry — exactly the four recurring household verbs.
 */
export function DailyPasses() {
  const titleId = useId();
  return (
    <section aria-labelledby={titleId}>
      <div className="flex items-start gap-2 border-b border-border pb-2">
        <Zap className="mt-0.5 size-4 shrink-0 text-slate" aria-hidden />
        <div>
          <h2 id={titleId} className="font-heading text-sm font-semibold">
            Daily passes
          </h2>
          <p className="text-xs text-muted-foreground">
            Useful household runs.
          </p>
        </div>
      </div>
      <Grid className="mt-2 grid-cols-2" gap="sm">
        {homeActions.map((action) => (
          // `render` keeps this one element: a <button> inside an <a> is
          // invalid HTML and gave every action two tab stops with ambiguous
          // announcement.
          <Button
            key={action.id}
            render={<Link to={action.path} search={action.search} />}
            // Base UI defaults `nativeButton`, which asserts a real <button>;
            // this one renders an anchor, so the flag has to say so.
            nativeButton={false}
            variant="outline"
            size="sm"
            className="h-11 w-full justify-start gap-2 transition-colors sm:h-8"
          >
            {action.entity ? (
              <EntityIcon
                entity={action.entity}
                colored
                className="size-4 shrink-0"
              />
            ) : (
              <action.icon className="size-4 shrink-0" />
            )}
            <span className="truncate">
              {action.entity
                ? `New ${entities[action.entity].label}`
                : action.name}
            </span>
          </Button>
        ))}
      </Grid>
      <Row gap="sm" wrap className="mt-2">
        <Button
          variant="ghost"
          size="sm"
          nativeButton={false}
          render={<Link to="/activities" />}
        >
          Browse activities
        </Button>
        <Button
          variant="ghost"
          size="sm"
          nativeButton={false}
          render={<Link to="/records" />}
        >
          All records
        </Button>
      </Row>
    </section>
  );
}
