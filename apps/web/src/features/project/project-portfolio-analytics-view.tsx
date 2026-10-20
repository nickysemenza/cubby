import type { EntityReportOut } from "@cubby/schemas/entity-report";
import { ChartBarIcon } from "@phosphor-icons/react/dist/csr/ChartBar";

import { ReportBlocks } from "~/entity/entity-detail/report-slot";
import { IndexedSections } from "~/ui/data-table/indexed-sections";
import {
  Visualization,
  visualizationState,
} from "~/ui/visualizations/visualization";

export type ProjectPortfolioAnalyticsViewProps = {
  data: EntityReportOut | undefined;
  isLoading: boolean;
  error: unknown;
  onRetry: () => void;
};

export function ProjectPortfolioAnalyticsView({
  data,
  isLoading,
  error,
  onRetry,
}: ProjectPortfolioAnalyticsViewProps) {
  return (
    <Visualization
      state={visualizationState({
        data,
        isLoading,
        error,
        empty: false,
        onRetry,
      })}
      height={400}
    >
      {data ? (
        <IndexedSections
          groups={[
            {
              id: "detail-group-analytics",
              title: "Portfolio analytics",
              sections: data.blocks.map((block, index) => ({
                id: `portfolio-${index}`,
                icon: ChartBarIcon,
                overflowVisible: true,
                title:
                  "title" in block ? (block.title ?? "Portfolio") : "Portfolio",
                content: <ReportBlocks blocks={[block]} />,
              })),
            },
          ]}
        />
      ) : null}
    </Visualization>
  );
}
