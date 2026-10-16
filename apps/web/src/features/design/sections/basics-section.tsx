import { FloppyDiskIcon } from "@phosphor-icons/react/dist/csr/FloppyDisk";
import { useId, useState } from "react";

import { FormFieldGroup } from "~/ui/forms/form-field-group";
import { Row, Stack } from "~/ui/layout";
import { Overlay } from "~/ui/overlays/overlay";
import { Alert, AlertDescription, AlertTitle } from "~/ui/primitives/alert";
import { Badge } from "~/ui/primitives/badge";
import { Button } from "~/ui/primitives/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/ui/primitives/card";
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
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "~/ui/primitives/empty";
import { Input } from "~/ui/primitives/input";
import { Label } from "~/ui/primitives/label";
import { Skeleton } from "~/ui/primitives/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/ui/primitives/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/ui/primitives/tabs";

const DOMAIN_SWATCHES = [
  ["Cook", "var(--domain-cook)", "var(--domain-cook-surface)"],
  ["Pantry", "var(--domain-pantry)", "var(--domain-pantry-surface)"],
  ["Plan", "var(--domain-plan)", "var(--domain-plan-surface)"],
  ["House", "var(--domain-house)", "var(--domain-house-surface)"],
  ["Finance", "var(--domain-finance)", "var(--domain-finance-surface)"],
] as const;

export function FoundationsSection() {
  return (
    <Stack gap="md">
      <Card>
        <CardHeader>
          <CardTitle>Field Guide foundations</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-2 sm:grid-cols-5">
            {DOMAIN_SWATCHES.map(([label, accent, surface]) => (
              <div
                key={label}
                className="overflow-hidden rounded-md border"
                style={{ background: surface }}
              >
                <div className="h-1.5" style={{ background: accent }} />
                <div className="px-2.5 py-2 text-xs font-medium">{label}</div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
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
        <Card>
          <CardHeader>
            <CardTitle>Working field</CardTitle>
          </CardHeader>
          <CardContent>
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
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Control states</CardTitle>
          </CardHeader>
          <CardContent>
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
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Menus</CardTitle>
          </CardHeader>
          <CardContent>
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
                      <DropdownMenuItem disabled>
                        Disabled view
                      </DropdownMenuItem>
                    </DropdownMenuSubmenuContent>
                  </DropdownMenuSubmenu>
                  <DropdownMenuItem disabled>Disabled action</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </Row>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Purchase lines</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table className="min-w-[32rem] table-auto">
              <TableHeader>
                <TableRow>
                  <TableHead>Line</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow>
                  <TableCell>Illustrative materials order</TableCell>
                  <TableCell>
                    <Badge variant="positive">Matched</Badge>
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    $120.00
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell>Illustrative hardware order</TableCell>
                  <TableCell>
                    <Badge variant="warning">Pending</Badge>
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    $300.00
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </Stack>
  );
}

export function FeedbackSection() {
  const [dialogOpen, setDialogOpen] = useState(false);
  return (
    <Stack gap="md">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Feedback and loading</CardTitle>
          </CardHeader>
          <CardContent>
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
              <div className="space-y-2 rounded-lg border p-3">
                <Skeleton className="h-3 w-2/5" />
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-3 w-4/5" />
              </div>
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>No illustrative matches</EmptyTitle>
                  <EmptyDescription>
                    An empty result explains what to try next.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            </Stack>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Responsive dialog</CardTitle>
          </CardHeader>
          <CardContent>
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
                <Input
                  aria-label="Item name"
                  defaultValue="Illustrative item"
                />
              </FormFieldGroup>
            </Overlay>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Tabs and status</CardTitle>
          </CardHeader>
          <CardContent>
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
          </CardContent>
        </Card>
      </div>
    </Stack>
  );
}
