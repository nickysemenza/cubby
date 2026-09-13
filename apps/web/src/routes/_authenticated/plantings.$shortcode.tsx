import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { PlantingDetail } from "~/app/garden/planting-detail";
import { RouteErrorComponent } from "~/components/lazy-route-error";
import { Page } from "~/components/page/Page";
import { entityDetailFor } from "~/entities/entity-detail.functions";
import { shortcodeHead } from "~/lib/page-title";

export const Route = createFileRoute("/_authenticated/plantings/$shortcode")({
  component: PlantingPage,
  errorComponent: RouteErrorComponent,
  head: shortcodeHead,
});
function PlantingPage() {
  const { shortcode } = Route.useParams();
  const planting = useQuery(
    entityDetailFor("planting").queryOptions(shortcode),
  );
  if (planting.isPending) return <p>Loading planting…</p>;
  if (planting.isError) throw planting.error;
  return (
    <Page variant="detail" title="Planting" entity="planting">
      {planting.data ? (
        <PlantingDetail
          key={shortcode}
          planting={planting.data}
          refresh={() => void planting.refetch()}
        />
      ) : (
        <p>Planting not found.</p>
      )}
    </Page>
  );
}
