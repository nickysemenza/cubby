import { FloppyDiskIcon } from "@phosphor-icons/react/dist/csr/FloppyDisk";
import { useId, useState } from "react";

import { EmptyState } from "~/ui/feedback/empty-state";
import { FormFieldGroup } from "~/ui/forms/form-field-group";
import { Panel, Row, Section, Stack } from "~/ui/layout";
import { Overlay } from "~/ui/overlays/overlay";
import { Alert, AlertDescription, AlertTitle } from "~/ui/primitives/alert";
import { Badge } from "~/ui/primitives/badge";
import { Button } from "~/ui/primitives/button";
import { Checkbox } from "~/ui/primitives/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSubmenu,
  DropdownMenuSubmenuContent,
  DropdownMenuSubmenuTrigger,
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";
import { Input } from "~/ui/primitives/input";
import { Label } from "~/ui/primitives/label";
import { Skeleton } from "~/ui/primitives/skeleton";
import { StaticTable } from "~/ui/primitives/static-table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/ui/primitives/tabs";

const FOUNDATION_SWATCHES = [
  ["Surface", "var(--background)"],
  ["Muted surface", "var(--muted)"],
  ["Foreground", "var(--foreground)"],
  ["Secondary ink", "var(--muted-foreground)"],
  ["Separator", "var(--border)"],
] as const;

export function FoundationsSection() {
  return (
    <Stack gap="md">
      <Section headingAs="h2" title="Field Guide foundations">
        <div className="grid gap-2 sm:grid-cols-5">
          {FOUNDATION_SWATCHES.map(([label, color]) => (
            <Panel
              key={label}
              tone="default"
              className="flex items-center gap-2"
            >
              <span
                aria-hidden
                className="size-4 shrink-0 rounded-sm border border-border"
                style={{ background: color }}
              />
              <span className="text-xs font-medium">{label}</span>
            </Panel>
          ))}
        </div>
      </Section>
    </Stack>
  );
}

export function ControlsSection() {
  const projectNameId = useId();
  const selectedCheckboxId = useId();
  const unselectedCheckboxId = useId();
  const disabledCheckboxId = useId();
  const invalidFieldId = useId();
  const invalidDescriptionId = useId();
  const invalidErrorId = useId();
  return (
    <Stack gap="md">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Section headingAs="h2" title="Working field">
          <Stack gap="sm">
            <Label htmlFor={projectNameId}>Project name</Label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                id={projectNameId}
                defaultValue="Illustrative pantry project"
              />
              <Button className="sm:shrink-0">
                <FloppyDiskIcon />
                Save
              </Button>
            </div>
            <Row align="center" wrap gap="sm">
              <Badge>Current</Badge>
              <Badge variant="positive">On track</Badge>
              <Badge variant="warning">Needs receipt</Badge>
            </Row>
          </Stack>
        </Section>
        <Section headingAs="h2" title="Control states">
          <Stack gap="md">
            <Row align="center" wrap gap="sm">
              <Button>Primary</Button>
              <Button variant="outline">Outline</Button>
              <Button variant="secondary">Secondary</Button>
              <Button variant="ghost">Ghost</Button>
              <Button variant="destructive">Destructive</Button>
              <Button disabled>Disabled</Button>
            </Row>
            <div className="grid gap-3 sm:grid-cols-2">
              <Input aria-label="Default field" placeholder="Default" />
              <Input
                aria-label="Invalid field"
                aria-invalid="true"
                defaultValue="Needs attention"
              />
              <Input aria-label="Disabled field" disabled value="Disabled" />
            </div>
            <FormFieldGroup
              htmlFor={invalidFieldId}
              label="Invalid form field"
              description="A short explanation stays with the field."
              descriptionId={invalidDescriptionId}
              errorId={invalidErrorId}
              invalid
              error={{ type: "validate", message: "Enter a project name." }}
            >
              <Input
                id={invalidFieldId}
                aria-invalid="true"
                aria-describedby={`${invalidDescriptionId} ${invalidErrorId}`}
                defaultValue=""
                placeholder="Project name"
              />
            </FormFieldGroup>
            <Row align="center" wrap gap="md">
              <label
                htmlFor={selectedCheckboxId}
                className="flex min-h-11 items-center gap-2 text-sm md:min-h-0 md:text-xs"
              >
                <Checkbox id={selectedCheckboxId} defaultChecked /> Selected
              </label>
              <label
                htmlFor={unselectedCheckboxId}
                className="flex min-h-11 items-center gap-2 text-sm md:min-h-0 md:text-xs"
              >
                <Checkbox id={unselectedCheckboxId} /> Unselected
              </label>
              <label
                htmlFor={disabledCheckboxId}
                className="flex min-h-11 items-center gap-2 text-sm text-muted-foreground md:min-h-0 md:text-xs"
              >
                <Checkbox id={disabledCheckboxId} disabled /> Disabled
              </label>
            </Row>
          </Stack>
        </Section>
        <Section headingAs="h2" title="Menus">
          <Row>
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="outline" />}>
                Open actions
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem>Review item</DropdownMenuItem>
                <DropdownMenuSubmenu>
                  <DropdownMenuSubmenuTrigger>
                    Move to view
                  </DropdownMenuSubmenuTrigger>
                  <DropdownMenuSubmenuContent>
                    <DropdownMenuItem>Current view</DropdownMenuItem>
                    <DropdownMenuItem disabled>Disabled view</DropdownMenuItem>
                  </DropdownMenuSubmenuContent>
                </DropdownMenuSubmenu>
                <DropdownMenuItem disabled>Disabled action</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </Row>
        </Section>
        <Section headingAs="h2" title="Purchase lines">
          <StaticTable
            className="min-w-[32rem] table-auto"
            rows={[
              {
                name: "Illustrative materials order",
                matched: true,
                cost: "$120.00",
              },
              {
                name: "Illustrative hardware order",
                matched: false,
                cost: "$300.00",
              },
            ]}
            rowKey={(row) => row.name}
            columns={[
              { id: "line", header: "Line", cell: (row) => row.name },
              {
                id: "status",
                header: "Status",
                cell: (row) => (
                  <Badge variant={row.matched ? "positive" : "warning"}>
                    {row.matched ? "Matched" : "Pending"}
                  </Badge>
                ),
              },
              {
                id: "cost",
                header: "Cost",
                headClassName: "text-right",
                cellClassName: "text-right font-mono tabular-nums",
                cell: (row) => row.cost,
              },
            ]}
          />
        </Section>
      </div>
    </Stack>
  );
}

export function FeedbackSection() {
  const [dialogOpen, setDialogOpen] = useState(false);
  return (
    <Stack gap="md">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Section headingAs="h2" title="Feedback and loading">
          <Stack gap="md">
            <Alert>
              <AlertTitle>Ready to review</AlertTitle>
              <AlertDescription>
                Neutral feedback stays quiet and specific.
              </AlertDescription>
            </Alert>
            <Alert variant="destructive">
              <AlertTitle>Couldn’t save</AlertTitle>
              <AlertDescription>
                Keep the attempted values and offer a retry.
              </AlertDescription>
            </Alert>
            <Panel tone="default" className="space-y-2">
              <Skeleton className="h-3 w-2/5" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-3 w-4/5" />
            </Panel>
            <EmptyState
              size="page"
              description="An empty result explains what to try next."
            >
              No illustrative matches
            </EmptyState>
          </Stack>
        </Section>
        <Section headingAs="h2" title="Responsive dialog">
          <Button variant="outline" onClick={() => setDialogOpen(true)}>
            Open dialog
          </Button>
          <Overlay
            open={dialogOpen}
            onOpenChange={setDialogOpen}
            title="Illustrative edit"
            description="A synthetic form in the shared dialog shell."
            cancelLabel="Done"
          >
            <FormFieldGroup label="Item name">
              <Input aria-label="Item name" defaultValue="Illustrative item" />
            </FormFieldGroup>
          </Overlay>
        </Section>
        <Section headingAs="h2" title="Tabs and status">
          <Tabs defaultValue="overview">
            <TabsList variant="line">
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="relations">Relations</TabsTrigger>
              <TabsTrigger value="activity">Activity</TabsTrigger>
            </TabsList>
            <TabsContent value="overview">
              <Row align="center" wrap gap="sm">
                <Badge>Current</Badge>
                <Badge variant="positive">On track</Badge>
                <Badge variant="warning">Needs receipt</Badge>
                <Badge variant="destructive">Failed</Badge>
                <Badge variant="outline">Neutral</Badge>
              </Row>
            </TabsContent>
            <TabsContent value="relations">
              Relationship content uses the same compact tab structure.
            </TabsContent>
            <TabsContent value="activity">
              Activity content remains readable at normal density.
            </TabsContent>
          </Tabs>
        </Section>
      </div>
    </Stack>
  );
}
