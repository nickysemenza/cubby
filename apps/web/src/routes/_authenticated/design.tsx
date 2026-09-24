import { ClipboardTextIcon } from "@phosphor-icons/react/dist/csr/ClipboardText";
import { FloppyDiskIcon } from "@phosphor-icons/react/dist/csr/FloppyDisk";
import { createFileRoute } from "@tanstack/react-router";
import { useId } from "react";

import { Row, Stack } from "~/components/layout";
import { Page } from "~/components/page/Page";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { NativeSelect } from "~/components/ui/native-select";
import { Skeleton } from "~/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { pageTitle } from "~/lib/page-title";

export const Route = createFileRoute("/_authenticated/design")({
  head: () => ({ meta: [{ title: pageTitle("Design smoke test") }] }),
  component: DesignSmokeTest,
});

const PROJECT_STATS = [
  { label: "Tasks", value: "5 / 8" },
  { label: "Purchases", value: "3" },
  { label: "Recorded spend", value: "$420.00" },
];

const DOMAIN_SWATCHES = [
  ["Cook", "var(--domain-cook)", "var(--domain-cook-surface)"],
  ["Pantry", "var(--domain-pantry)", "var(--domain-pantry-surface)"],
  ["Plan", "var(--domain-plan)", "var(--domain-plan-surface)"],
  ["House", "var(--domain-house)", "var(--domain-house-surface)"],
  ["Finance", "var(--domain-finance)", "var(--domain-finance-surface)"],
] as const;

function DesignSmokeTest() {
  const projectNameId = useId();
  const stateSelectId = useId();
  const selectedCheckboxId = useId();
  const unselectedCheckboxId = useId();
  const disabledCheckboxId = useId();

  return (
    <Page
      variant="detail"
      entity="project"
      title="Illustrative project detail"
      heroNo="PRJ-4K7M"
      rawData={{ createdAt: "2026-01-15T12:00:00Z" }}
      heroStamp={{ label: "In progress" }}
      heroStats={PROJECT_STATS}
      heroActions={{
        primary: (
          <Button variant="outline" size="sm">
            <ClipboardTextIcon />
            Review
          </Button>
        ),
      }}
    >
      <Stack gap="lg">
        <Card>
          <CardHeader>
            <CardTitle>Porcelain Transit foundations</CardTitle>
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
                  <Input
                    aria-label="Disabled field"
                    disabled
                    value="Disabled"
                  />
                  <div>
                    <Label htmlFor={stateSelectId}>Native select</Label>
                    <NativeSelect id={stateSelectId} defaultValue="current">
                      <option value="current">Current</option>
                      <option value="archived">Archived</option>
                    </NativeSelect>
                  </div>
                </div>
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
              </Stack>
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
    </Page>
  );
}
