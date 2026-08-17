import { createFileRoute } from "@tanstack/react-router";
import { ClipboardList, Save } from "lucide-react";
import { useId } from "react";
import { Row, Stack } from "~/components/layout";
import { Page } from "~/components/page/Page";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
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

function DesignSmokeTest() {
  const projectNameId = useId();

  return (
    <Page
      variant="detail"
      entity="project"
      title="Illustrative project detail"
      heroNo="PRJ-4K7M"
      rawData={{ createdAt: "2026-01-15T12:00:00Z" }}
      heroStamp={{ label: "In progress" }}
      heroStats={PROJECT_STATS}
      actions={
        <Button variant="outline" size="sm">
          <ClipboardList />
          Review
        </Button>
      }
    >
      <Stack gap="lg">
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
                    <Save />
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
        </div>
      </Stack>
    </Page>
  );
}
