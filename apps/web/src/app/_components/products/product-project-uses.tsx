import { useQuery } from "@tanstack/react-query";
import { Pencil, Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import { useProjectOptions } from "~/app/_components/hooks/useProjectOptions";
import { PROJECT_STATUS_LABELS } from "~/app/projects/project-formatting";
import { Row, Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
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
import { formatCurrency } from "~/lib/utils";

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

  const detach = useActionMutation({
    mutationFn: api.project.setToolUsage.mutationOptions,
    success: "Removed from project",
    invalidateKeys: projectResourceMutationInvalidateKeys,
  });

  if (query.isPending) {
    return <Description>Loading project uses…</Description>;
  }

  const data = query.data;
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

      <Stack gap="xs">
        {data.projects.map((project) => (
          <Row
            key={project.projectId}
            align="center"
            justify="between"
            gap="md"
            className="border border-[var(--border)] p-4"
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
            <Row align="center" gap="sm" className="shrink-0">
              {data.category === "tools" &&
                project.projectPurchaseCost !== null &&
                project.projectPurchaseCost > 0 && (
                  <Badge variant="outline">
                    {formatCurrency(project.projectPurchaseCost)} bought here
                  </Badge>
                )}
              {data.category === "software" && project.sharedWindow && (
                <Stack gap="xs" className="text-right">
                  <Badge variant="outline">
                    {formatCurrency(project.sharedWindow.netCost)} shared spend
                  </Badge>
                  <Description size="xs">
                    {project.sharedWindow.startDate}–
                    {project.sharedWindow.endDate} · non-additive
                  </Description>
                </Stack>
              )}
              {data.category === "software" && !project.sharedWindow && (
                <Description size="xs" className="text-right">
                  Shared spend unavailable
                </Description>
              )}
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Remove ${project.projectName}`}
                disabled={detach.isPending}
                onClick={() =>
                  detach.mutate({
                    projectId: project.projectId,
                    productId,
                    used: false,
                  })
                }
              >
                <X aria-hidden />
              </Button>
            </Row>
          </Row>
        ))}
      </Stack>

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
  const { options, isLoading } = useProjectOptions();
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

  const save = useActionMutation({
    mutationFn: api.product.setProjectUses.mutationOptions,
    success: "Project uses updated",
    invalidateKeys: projectResourceMutationInvalidateKeys,
    onSuccess: () => onOpenChange(false),
  });

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return options;
    return options.filter((option) =>
      option.label.toLowerCase().includes(term),
    );
  }, [options, search]);

  const toggle = (value: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(value);
      else next.delete(value);
      return next;
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
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

        <Stack gap="xs" className="max-h-80 overflow-y-auto">
          {isLoading && <Description>Loading projects…</Description>}
          {!isLoading && visible.length === 0 && (
            <Description>No projects match.</Description>
          )}
          {visible.map((option) => (
            <Row
              key={option.value}
              as="label"
              align="center"
              gap="sm"
              className="cursor-pointer border border-[var(--border)] px-2 py-1"
            >
              <Checkbox
                checked={selected.has(option.value)}
                onCheckedChange={(checked) =>
                  toggle(option.value, checked === true)
                }
              />
              <span className="truncate">{option.label}</span>
            </Row>
          ))}
        </Stack>

        <DialogFooter>
          <Row align="center" gap="sm" className="mr-auto">
            <Description size="xs">{selected.size} selected</Description>
          </Row>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
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
