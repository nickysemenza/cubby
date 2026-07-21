import type { CostType, PurchaseOut, Trade } from "@cubby/schemas/project";
import { Link } from "@tanstack/react-router";
import { ExternalLink, Info } from "lucide-react";
import type { FC } from "react";
import { TradeBadge, tradeOptions } from "~/app/projects/shared";
import { BasicInfo, type BasicInfoField } from "~/components/common/basic-info";
import { Page } from "~/components/page/Page";
import { Badge } from "~/components/ui/badge";
import { NoneValue } from "~/components/ui/none-value";
import { useTRPC } from "~/integrations/trpc/react";
import { purchaseMutationInvalidateKeys } from "~/lib/query-keys";
import { formatCurrency } from "~/lib/utils";
import {
  type DetailHeroStat,
  type DetailSection,
  DetailSections,
} from "../_components/data-table/detail-page";
import { EditableCell } from "../_components/data-table/editable-cell";
import { useEntityDetail } from "../_components/hooks/useEntityDetail";
import { useUpdateMutation } from "../_components/hooks/useUpdateMutation";
import {
  costTypeLabels,
  costTypeOptions,
  futureFilterOptions,
} from "./purchase-options";

interface PurchaseDetailProps {
  purchase: PurchaseOut;
}

export const PurchaseDetail: FC<PurchaseDetailProps> = ({ purchase }) => {
  const api = useTRPC();

  const updateMutation = useUpdateMutation({
    mutationFn: api.purchase.update.mutationOptions,
    entity: "purchase",
    invalidateKeys: purchaseMutationInvalidateKeys,
  });

  // Common sections from entity config (History) — editMode/mappings unused
  // here since Overview is edited via inline EditableCell fields, not a Form.
  const { commonSections } = useEntityDetail<PurchaseOut, never>({
    entity: "purchase",
    data: purchase,
    mutationOptions: api.purchase.update.mutationOptions(),
    invalidateKeys: purchaseMutationInvalidateKeys,
  });

  const fields: BasicInfoField[] = [
    {
      label: "Name",
      value: (
        <EditableCell
          value={purchase.name}
          config={{ type: "text" }}
          onSave={async (name) => {
            if (!name) return;
            await updateMutation.mutateAsync({
              id: purchase.id,
              data: { name },
            });
          }}
          renderValue={(v) => v ?? <NoneValue />}
        />
      ),
    },
    {
      label: "Cost",
      value: (
        <EditableCell
          value={purchase.cost}
          config={{ type: "currency" }}
          onSave={async (cost) => {
            await updateMutation.mutateAsync({
              id: purchase.id,
              data: { cost },
            });
          }}
          renderValue={(v) =>
            v != null ? formatCurrency(v, 0) : <NoneValue />
          }
        />
      ),
    },
    {
      label: "Date",
      value: (
        <EditableCell
          value={purchase.date}
          config={{ type: "text", placeholder: "YYYY-MM-DD" }}
          onSave={async (date) => {
            await updateMutation.mutateAsync({
              id: purchase.id,
              data: { date },
            });
          }}
          renderValue={(v) => v ?? <NoneValue />}
        />
      ),
    },
    {
      label: "Cost Type",
      value: (
        <EditableCell
          value={purchase.costType}
          config={{ type: "select", options: costTypeOptions }}
          onSave={async (costType) => {
            // Required field — a cleared select is a no-op, not a null write.
            if (!costType) return;
            await updateMutation.mutateAsync({
              id: purchase.id,
              data: { costType: costType as CostType },
            });
          }}
          renderValue={(ct) =>
            ct ? costTypeLabels[ct as CostType] : <NoneValue />
          }
        />
      ),
    },
    {
      label: "Trade",
      value: (
        <EditableCell
          value={purchase.trade}
          config={{ type: "select", options: tradeOptions }}
          onSave={async (trade) => {
            // Required field — a cleared select is a no-op, not a null write.
            if (!trade) return;
            await updateMutation.mutateAsync({
              id: purchase.id,
              data: { trade: trade as Trade },
            });
          }}
          renderValue={(v) =>
            v ? <TradeBadge trade={v as Trade} /> : <NoneValue />
          }
        />
      ),
    },
    {
      label: "Planned",
      value: (
        <EditableCell
          value={String(purchase.future)}
          config={{ type: "select", options: futureFilterOptions }}
          onSave={async (value) => {
            await updateMutation.mutateAsync({
              id: purchase.id,
              data: { future: value === "true" },
            });
          }}
          renderValue={(v) =>
            v === "true" ? (
              <Badge variant="warning">Planned</Badge>
            ) : (
              <Badge variant="positive">Already made</Badge>
            )
          }
        />
      ),
    },
    {
      label: "URL",
      value: (
        <EditableCell
          value={purchase.url}
          config={{ type: "text", placeholder: "https://…" }}
          onSave={async (url) => {
            await updateMutation.mutateAsync({
              id: purchase.id,
              data: { url },
            });
          }}
          renderValue={(v) =>
            v ? (
              <a
                href={v}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="flex items-center gap-1 hover:underline"
              >
                {v}
                <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
              </a>
            ) : (
              <NoneValue />
            )
          }
        />
      ),
    },
    {
      label: "Notes",
      value: (
        <EditableCell
          value={purchase.notes}
          config={{ type: "text" }}
          onSave={async (notes) => {
            await updateMutation.mutateAsync({
              id: purchase.id,
              data: { notes },
            });
          }}
          renderValue={(v) => v ?? <NoneValue />}
        />
      ),
    },
    {
      label: "Project",
      value: purchase.projectId ? (
        <Link to="/projects/$id" params={{ id: purchase.projectId }}>
          <Badge variant="outline" className="cursor-pointer hover:bg-muted">
            {purchase.projectName}
          </Badge>
        </Link>
      ) : undefined,
    },
  ];

  const sections: DetailSection[] = [
    {
      title: "Overview",
      icon: Info,
      content: <BasicInfo fields={fields} />,
    },
    ...commonSections,
  ];

  const heroStats: DetailHeroStat[] = [
    {
      label: "Cost",
      value: purchase.cost != null ? formatCurrency(purchase.cost, 0) : "—",
    },
    { label: "Date", value: purchase.date ?? "—" },
    {
      label: "Cost Type",
      value: purchase.costType ? costTypeLabels[purchase.costType] : "—",
    },
  ];

  return (
    <Page
      variant="detail"
      entity="purchase"
      title={purchase.name}
      rawData={purchase}
      heroStamp={{
        label: purchase.future ? "Planned" : "Purchased",
        tone: purchase.future ? "ink" : "green",
      }}
      heroStats={heroStats}
    >
      <DetailSections sections={sections} rawData={purchase} />
    </Page>
  );
};
