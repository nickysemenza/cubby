import { useQuery } from "@tanstack/react-query";
import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import { PROJECT_STATUS_LABELS } from "~/app/projects/project-formatting";
import { Row, Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Description } from "~/components/ui/description";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "~/components/ui/empty";
import { useTRPC } from "~/integrations/trpc/react";
import { formatCurrency } from "~/lib/utils";

export function ProductProjectUses({ productId }: { productId: string }) {
  const api = useTRPC();
  const query = useQuery(api.product.projectUses.queryOptions({ productId }));

  if (query.isPending) {
    return <Description>Loading project uses…</Description>;
  }

  const data = query.data;
  if (!data || data.projects.length === 0) {
    return (
      <Empty variant="minimal" className="py-6">
        <EmptyHeader>
          <EmptyTitle>No project uses recorded</EmptyTitle>
          <EmptyDescription>
            Attach this tool from a project when it is used. Each exact project
            counts once.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <Stack gap="sm">
      <Row wrap gap="sm">
        <Badge variant="outline">
          {data.projectUseCount} project use
          {data.projectUseCount === 1 ? "" : "s"}
        </Badge>
        <Badge variant="outline">
          {formatCurrency(data.netLifetimeCost)} net lifetime cost
        </Badge>
        <Badge variant="outline">
          {data.costPerProjectUse === null
            ? "Cost/use pending"
            : `${formatCurrency(data.costPerProjectUse)} per use`}
        </Badge>
      </Row>

      <Stack gap="xs">
        {data.projects.map((project) => (
          <Row
            key={project.projectId}
            align="center"
            justify="between"
            gap="md"
            className="border border-[var(--border)] p-3"
          >
            <Stack gap="xs" className="min-w-0">
              <EntityInlineLink
                entity="project"
                data={{
                  id: project.projectId,
                  name: project.projectName,
                  status: project.status,
                  kind: project.kind,
                }}
                truncate
              />
              <Description size="xs">
                {PROJECT_STATUS_LABELS[project.status]}
              </Description>
            </Stack>
            {project.projectPurchaseCost > 0 && (
              <Badge variant="outline" className="shrink-0">
                {formatCurrency(project.projectPurchaseCost)} bought here
              </Badge>
            )}
          </Row>
        ))}
      </Stack>
    </Stack>
  );
}
