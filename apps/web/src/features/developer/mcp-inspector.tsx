import { mcpToolCatalogOut } from "@cubby/schemas/telemetry";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { z } from "zod";

import { mcp } from "~/integrations/tanstack-query/generated/catalog.gen";
import { SimpleLoading } from "~/ui/feedback/loading-skeletons";
import { Row, Section, Stack } from "~/ui/layout";
import { Badge } from "~/ui/primitives/badge";
import { Button } from "~/ui/primitives/button";
import { Description } from "~/ui/primitives/description";
import { Input } from "~/ui/primitives/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/ui/primitives/tabs";

import { McpUsageDashboard } from "./mcp-usage-dashboard";

const jsonValueSchema = z.json();
type JsonValue = z.infer<typeof jsonValueSchema>;
type CatalogTool = z.infer<typeof mcpToolCatalogOut>["tools"][number];

function schemaHasMock(value: JsonValue): boolean {
  if (value === null) return false;
  if (Array.isArray(value)) return value.some(schemaHasMock);
  const object = z.record(z.string(), jsonValueSchema).safeParse(value);
  return object.success
    ? "mock" in object.data || Object.values(object.data).some(schemaHasMock)
    : false;
}

function AnnotationBadges({ tool }: { tool: CatalogTool }) {
  const annotations = tool.annotations ?? {};
  const badges: Array<{
    label: string;
    variant: "default" | "destructive" | "secondary" | "outline";
  }> = [];

  if (annotations.readOnlyHint !== true) {
    badges.push({ label: "Write", variant: "default" });
  }
  if (annotations.destructiveHint === true) {
    badges.push({ label: "Destructive", variant: "destructive" });
  }
  if (annotations.openWorldHint === true) {
    badges.push({ label: "Open world", variant: "secondary" });
  }
  if (!tool.outputSchema) {
    badges.push({ label: "No output schema", variant: "outline" });
  }

  if (badges.length === 0) {
    return <Badge variant="outline">Read only</Badge>;
  }

  return (
    <Row wrap gap="xs">
      {badges.map((badge) => (
        <Badge key={badge.label} variant={badge.variant}>
          {badge.label}
        </Badge>
      ))}
    </Row>
  );
}

function SchemaPanel({
  title,
  schema,
}: {
  title: string;
  schema?: CatalogTool["inputSchema"];
}) {
  return (
    <Section headingAs="h2" title={title}>
      {schema ? (
        <pre className="max-h-[420px] overflow-auto rounded-md bg-muted p-2 text-xs leading-relaxed">
          {JSON.stringify(schema, null, 2)}
        </pre>
      ) : (
        <Description>Not defined</Description>
      )}
    </Section>
  );
}

export function CatalogErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <Stack role="alert" gap="sm" className="items-start">
      <Description className="text-destructive">
        Failed to load MCP catalog: {message}
      </Description>
      <Button type="button" variant="outline" onClick={onRetry}>
        Retry catalog
      </Button>
    </Stack>
  );
}

function CatalogInspector() {
  const { data, isLoading, error, refetch } = useQuery(
    mcp.listTools.queryOptions(null),
  );
  const [query, setQuery] = useState("");
  const [selectedName, setSelectedName] = useState<string | null>(null);

  const tools = data?.tools ?? [];

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tools;
    return tools.filter(
      (tool) =>
        tool.name.toLowerCase().includes(q) ||
        tool.description?.toLowerCase().includes(q),
    );
    // oxlint-disable-next-line react/exhaustive-deps -- The fresh wrapper is intentionally excluded; stable semantic members and scalar keys govern this hook.
  }, [tools, query]);

  const selected =
    filtered.find((tool) => tool.name === selectedName) ?? filtered[0] ?? null;

  if (isLoading) return <SimpleLoading />;
  if (error) {
    return (
      <CatalogErrorState
        message={error.message}
        onRetry={() => void refetch()}
      />
    );
  }

  return (
    <Stack gap="lg">
      {data?.instructions ? (
        <Section
          headingAs="h2"
          title="Server instructions"
          caption="Workflow guidance exposed to MCP clients via tools/list metadata."
        >
          <pre className="rounded-md bg-muted p-2 text-xs leading-relaxed whitespace-pre-wrap">
            {data.instructions}
          </pre>
        </Section>
      ) : null}

      <Row align="start" gap="lg" className="items-start">
        <Section
          headingAs="h2"
          title="Tools"
          caption={<>{tools.length} registered tools</>}
          className="w-full max-w-sm shrink-0"
        >
          <div className="space-y-2">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search tools…"
            />
            <div className="max-h-[70vh] space-y-1 overflow-auto">
              {filtered.map((tool) => (
                <button
                  key={tool.name}
                  type="button"
                  onClick={() => setSelectedName(tool.name)}
                  className={`block min-h-11 w-full rounded-md px-2 py-2 text-left text-sm transition-colors hover:bg-muted md:min-h-8 ${
                    selected?.name === tool.name ? "bg-muted font-medium" : ""
                  }`}
                >
                  {tool.name}
                </button>
              ))}
            </div>
          </div>
        </Section>

        {selected ? (
          <Stack className="min-w-0 flex-1" gap="md">
            <Section
              headingAs="h2"
              title={selected.name}
              caption={selected.description || undefined}
            >
              <AnnotationBadges tool={selected} />
              {selected.inputSchema && schemaHasMock(selected.inputSchema) ? (
                <Badge variant="destructive">Contains mock metadata</Badge>
              ) : null}
              {selected.annotations ? (
                <pre className="rounded-md bg-muted p-2 text-xs leading-relaxed">
                  {JSON.stringify(selected.annotations, null, 2)}
                </pre>
              ) : null}
            </Section>

            <SchemaPanel title="Input schema" schema={selected.inputSchema} />
            <SchemaPanel title="Output schema" schema={selected.outputSchema} />
          </Stack>
        ) : (
          <Description>Select a tool to inspect its schemas.</Description>
        )}
      </Row>
    </Stack>
  );
}

export function McpInspector() {
  return (
    <Tabs defaultValue="usage">
      <TabsList>
        <TabsTrigger value="usage">Usage</TabsTrigger>
        <TabsTrigger value="catalog">Catalog</TabsTrigger>
      </TabsList>
      <TabsContent value="usage" className="pt-4">
        <McpUsageDashboard />
      </TabsContent>
      <TabsContent value="catalog" className="pt-4">
        <CatalogInspector />
      </TabsContent>
    </Tabs>
  );
}
