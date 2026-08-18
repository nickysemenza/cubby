import type { ProjectShortcode } from "@cubby/schemas/identifiers";
import type { ProductProjectUsesOut } from "@cubby/schemas/project";
import { useQuery } from "@tanstack/react-query";
import type { RowSelectionState, Updater } from "@tanstack/react-table";
import { Pencil, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { VerbMenuItem } from "~/app/_components/actions/action-verb-ui";
import {
  createCurrencyColumn,
  createTimestampColumn,
} from "~/app/_components/data-table/columnHelpers";
import { buildSelectColumn } from "~/app/_components/data-table/row-selection";
import RTable from "~/app/_components/data-table/Table";
import {
  type CubbyColumnDef,
  createCubbyColumnHelper,
  useCubbyTable,
} from "~/app/_components/data-table/table-features";
import { useCubbyTableLayout } from "~/app/_components/data-table/table-layout";
import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import { useClientEntityList } from "~/app/_components/hooks/useClientEntityList";
import { useProjectOptions } from "~/app/_components/hooks/useProjectOptions";
import { ProjectMark } from "~/app/projects/project-mark";
import { Row, Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Description } from "~/components/ui/description";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "~/components/ui/empty";
import { Input } from "~/components/ui/input";
import { useTRPC } from "~/integrations/trpc/react";
import { projectResourceMutationInvalidateKeys } from "~/lib/query-keys";
import { getStatusBadgeProps } from "~/lib/status-colors";
import { formatCurrency } from "~/lib/utils";

type ProjectUse = ProductProjectUsesOut["projects"][number];
/** `id`/`name` are what the shared list hook keys and links rows by. */
type ProjectUseRow = ProjectUse & { id: ProjectShortcode; name: string };

/** Stable hook config (see apps/web/CLAUDE.md on inline objects). */
const EMBEDDED_TABLE_STATE = {
  urlSync: false,
  readUrlState: false,
} as const;

/**
 * The project entity's default-on graph previews (Blocked by, Used tools) are
 * about the project's own page, not about this tool's history with it — and
 * "Used tools" would list all 48 of them beside the one row you're reading.
 * Reachable from the View menu; just not the default here.
 */
const HIDDEN_RELATED_COLUMNS = {
  "related:project.blockedBy": false,
  "related:project.usedTools": false,
} as const;

/**
 * Which projects a tool was used on, edited from the tool's own page.
 *
 * The project-detail section attaches tools to one project; this is the
 * transpose, and it is how history actually gets reconstructed — tool by tool,
 * from memory. Bulk edits go through `product.setProjectUses` (one atomic
 * replacement, one product-keyed audit entry) rather than N per-project
 * attaches, which could half-apply and would log N entries for one action.
 */
export function ProductProjectUses({ productId }: { productId: string }) {
  const api = useTRPC();
  const [editing, setEditing] = useState(false);
  const query = useQuery(api.product.projectUses.queryOptions({ productId }));
  const data = query.data;

  const detach = useActionMutation({
    mutationFn: api.project.setToolUsage.mutationOptions,
    success: "Removed from project",
    invalidateKeys: projectResourceMutationInvalidateKeys,
  });

  const rows = useMemo<ProjectUseRow[]>(
    () =>
      (data?.projects ?? []).map((project) => ({
        ...project,
        id: project.projectId,
        name: project.projectName,
      })),
    [data],
  );

  const helper = useMemo(() => createCubbyColumnHelper<ProjectUseRow>(), []);
  const category = data?.category;
  const columns = useMemo(
    () => [
      helper.accessor((row) => row.status, {
        id: "status",
        header: "Status",
        meta: { className: "w-32" },
        cell: (info) => {
          const { label, className } = getStatusBadgeProps(
            "project",
            info.getValue(),
          );
          return <Badge className={className}>{label}</Badge>;
        },
      }),
      ...(category === "software"
        ? [
            helper.accessor((row) => row.sharedWindow, {
              id: "sharedSpend",
              header: "Shared spend",
              meta: { className: "w-48" },
              cell: (info) => {
                const window = info.getValue();
                if (!window) {
                  return (
                    <Description size="xs">
                      Shared spend unavailable
                    </Description>
                  );
                }
                return (
                  <Stack gap="tight">
                    <span className="font-mono tabular-nums">
                      {formatCurrency(window.netCost)}
                    </span>
                    <Description size="xs">
                      {window.startDate}–{window.endDate} · non-additive
                    </Description>
                  </Stack>
                );
              },
            }),
          ]
        : [
            createCurrencyColumn(helper, "projectPurchaseCost", {
              header: "Bought here",
              className: "w-28",
            }),
          ]),
      createTimestampColumn(helper, "attachedAt", {
        header: "Attached",
        className: "w-32",
      }),
    ],
    [helper, category],
  );

  const { table, bulkActionBar, deleteDialog } =
    useClientEntityList<ProjectUseRow>({
      entity: "project",
      data: rows,
      columns,
      tableStateOptions: EMBEDDED_TABLE_STATE,
      layoutKey: "project:product-uses",
      initialColumnVisibility: HIDDEN_RELATED_COLUMNS,
      extraActions: (row) => (
        <VerbMenuItem
          verb="removeFromProject"
          disabled={detach.isPending}
          onSelect={(event) => {
            event.stopPropagation();
            detach.mutate({ projectId: row.id, productId, used: false });
          }}
        />
      ),
    });

  if (query.isPending) {
    return <Description>Loading project uses…</Description>;
  }
  if (!data) return null;

  const editButton = (
    <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
      <Pencil aria-hidden />
      Edit projects
    </Button>
  );

  if (data.projects.length === 0) {
    return (
      <>
        <Empty variant="minimal" className="py-6">
          <EmptyHeader>
            <EmptyTitle>No project uses recorded</EmptyTitle>
            <EmptyDescription>
              Check off the projects this was used on. Each exact project counts
              once.
            </EmptyDescription>
          </EmptyHeader>
          {editButton}
        </Empty>
        <ProjectUsesDialog
          productId={productId}
          open={editing}
          onOpenChange={setEditing}
          selectedIds={[]}
        />
      </>
    );
  }

  return (
    <Stack gap="sm">
      <Row wrap gap="sm" align="center">
        <Badge variant="outline">
          {data.projectUseCount} project use
          {data.projectUseCount === 1 ? "" : "s"}
        </Badge>
        <Badge variant="outline">
          {formatCurrency(data.netLifetimeCost)}{" "}
          {data.category === "software"
            ? "lifetime household spend"
            : "net lifetime cost"}
        </Badge>
        {data.category === "tools" && (
          <Badge variant="outline">
            {data.costPerProjectUse === null
              ? "Cost/use pending"
              : `${formatCurrency(data.costPerProjectUse)} per use`}
          </Badge>
        )}
        <div className="ml-auto">{editButton}</div>
      </Row>

      <RTable
        table={table}
        entity="project"
        ariaLabel="Projects this was used on"
        embedded
        bulkActionBar={bulkActionBar}
      />
      {deleteDialog}

      <ProjectUsesDialog
        productId={productId}
        open={editing}
        onOpenChange={setEditing}
        selectedIds={data.projects.map((project) => project.projectId)}
      />
    </Stack>
  );
}

function ProjectUsesDialog({
  productId,
  open,
  onOpenChange,
  selectedIds,
}: {
  productId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedIds: string[];
}) {
  const api = useTRPC();
  const { rows, isLoading } = useProjectOptions();
  const [search, setSearch] = useState("");
  // Seeded from the server set each time the dialog opens, so a cancelled edit
  // leaves nothing behind.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [seededFor, setSeededFor] = useState(false);
  if (open && !seededFor) {
    setSelected(new Set(selectedIds));
    setSeededFor(true);
  }
  if (!open && seededFor) setSeededFor(false);
  const resetAndClose = (next: boolean) => {
    if (!next) {
      setSearch("");
      setSelected(new Set());
      setSeededFor(false);
    }
    onOpenChange(next);
  };

  const save = useActionMutation({
    mutationFn: api.product.setProjectUses.mutationOptions,
    success: "Project uses updated",
    invalidateKeys: projectResourceMutationInvalidateKeys,
    onSuccess: () => resetAndClose(false),
  });

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return rows;
    return rows.filter((row) => row.name.toLowerCase().includes(term));
  }, [rows, search]);
  const rowSelection = useMemo<RowSelectionState>(
    () => Object.fromEntries([...selected].map((id) => [id, true])),
    [selected],
  );
  const onRowSelectionChange = (updater: Updater<RowSelectionState>) => {
    const next =
      typeof updater === "function" ? updater(rowSelection) : updater;
    setSelected(
      new Set(
        Object.entries(next)
          .filter(([, value]) => value)
          .map(([id]) => id),
      ),
    );
  };
  type ProjectOptionRow = (typeof rows)[number];
  const helper = useMemo(() => createCubbyColumnHelper<ProjectOptionRow>(), []);
  const columns = useMemo<CubbyColumnDef<ProjectOptionRow>[]>(
    () => [
      buildSelectColumn<ProjectOptionRow>(),
      helper.display({
        id: "mark",
        header: "",
        meta: { className: "w-10", mobile: { slot: "image" } },
        cell: (info) => <ProjectMark icon={info.row.original.icon} size={20} />,
      }),
      helper.accessor((row) => row.name, {
        id: "name",
        header: "Project",
        meta: { className: "w-64", mobile: { slot: "title" } },
      }),
      helper.accessor((row) => row, {
        id: "effectiveDates",
        header: "Effective dates",
        enableSorting: false,
        meta: { className: "w-48", mobile: { slot: "meta", label: "Dates" } },
        cell: (info) => {
          const row = info.row.original;
          if (!row.effectiveStart && !row.effectiveEnd) return "—";
          return `${row.effectiveStart ?? "…"} – ${row.effectiveEnd ?? "…"}`;
        },
      }),
    ],
    [helper],
  );
  const layout = useCubbyTableLayout({
    key: "product:project-picker",
    columns,
  });
  const table = useCubbyTable({
    data: visible,
    columns: layout.columns,
    atoms: layout.atoms,
    meta: { defaultLayout: layout.defaultLayout },
    getRowId: (row) => row.id,
    enableRowSelection: true,
    state: { rowSelection },
    onRowSelectionChange,
    initialState: { pagination: { pageIndex: 0, pageSize: 100 } },
  });

  return (
    <Dialog open={open} onOpenChange={resetAndClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Projects this was used on</DialogTitle>
          <DialogDescription>
            Saving replaces the whole set. Projects left checked keep the date
            they were first attached.
          </DialogDescription>
        </DialogHeader>

        <Row align="center" gap="sm">
          <Search className="size-3.5 text-muted-foreground" aria-hidden />
          <Input
            value={search}
            placeholder="Filter projects"
            onChange={(event) => setSearch(event.target.value)}
          />
        </Row>

        <div className="max-h-80 overflow-y-auto">
          <RTable
            table={table}
            entity="project"
            ariaLabel="Projects available for this product"
            embedded
            isLoading={isLoading}
            emptyState={<Description>No projects match.</Description>}
          />
        </div>

        <DialogFooter>
          <Row align="center" gap="sm" className="mr-auto">
            <Description size="xs">{selected.size} selected</Description>
          </Row>
          <Button variant="outline" onClick={() => resetAndClose(false)}>
            Cancel
          </Button>
          <Button
            disabled={save.isPending}
            onClick={() =>
              save.mutate({ productId, projectIds: [...selected] })
            }
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
