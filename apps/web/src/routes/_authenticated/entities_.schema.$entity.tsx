import { entitySchema } from "@cubby/schemas/entity";
import { Link, createFileRoute, notFound } from "@tanstack/react-router";

import { EntitySchemaDetail } from "~/features/entity-platform/EntitySchemaInspector";
import { pageTitle } from "~/lib/page-title";
import { Page } from "~/ui/page/Page";
import { buttonVariants } from "~/ui/primitives/button";

export const Route = createFileRoute(
  "/_authenticated/entities_/schema/$entity",
)({
  params: {
    parse: (params) => {
      const entity = entitySchema.safeParse(params.entity);
      if (!entity.success) throw notFound();
      return { entity: entity.data };
    },
    stringify: (params) => params,
  },
  component: EntitySchemaPage,
  head: ({ params }) => ({
    meta: [{ title: pageTitle(`${params.entity} schema`) }],
  }),
});

function EntitySchemaPage() {
  const { entity } = Route.useParams();
  return (
    <Page
      variant="list"
      title="Entity schema"
      compact
      decoration="none"
      bodyGutter="standard"
      actions={
        <Link
          to="/entities"
          search={{ tab: "schema", entity }}
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          Back to schema sheet
        </Link>
      }
    >
      <EntitySchemaDetail entity={entity} />
    </Page>
  );
}
