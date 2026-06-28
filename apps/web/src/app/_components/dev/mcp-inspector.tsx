import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { SimpleLoading } from "~/components/feedback/loading-skeletons";
import { Row, Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { Description } from "~/components/ui/description";
import { Input } from "~/components/ui/input";
import { useTRPC } from "~/trpc/react";

type ToolAnnotations = {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

type CatalogTool = {
  name: string;
  description?: string;
  title?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: ToolAnnotations;
};

function schemaHasMock(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(schemaHasMock);
  const obj = value as Record<string, unknown>;
  if ("mock" in obj) return true;
  return Object.values(obj).some(schemaHasMock);
}

function AnnotationBadges({ tool }: { tool: CatalogTool }) {
  const annotations = tool.annotations ?? {};
  const badges: Array<{
    label: string;
    variant: "default" | "destructive" | "secondary" | "outline";
  }> = [];

  if (annotations.readOnlyHint !== true) {
    badges.push({ label: "WRITE", variant: "default" });
  }
  if (annotations.destructiveHint === true) {
    badges.push({ label: "DESTRUCTIVE", variant: "destructive" });
  }
  if (annotations.openWorldHint === true) {
    badges.push({ label: "OPEN WORLD", variant: "secondary" });
  }
  if (!tool.outputSchema) {
    badges.push({ label: "NO OUTPUT SCHEMA", variant: "outline" });
  }

  if (badges.length === 0) {
    return <Badge variant="outline">READ ONLY</Badge>;
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
  schema?: Record<string, unknown>;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {schema ? (
          <pre className="max-h-[420px] overflow-auto rounded-md bg-muted p-2 text-xs leading-relaxed">
            {JSON.stringify(schema, null, 2)}
          </pre>
        ) : (
          <Description>Not defined</Description>
        )}
      </CardContent>
    </Card>
  );
}

export function McpInspector() {
  const api = useTRPC();
  const { data, isLoading, error } = useQuery(api.mcp.listTools.queryOptions());
  const [query, setQuery] = useState("");
  const [selectedName, setSelectedName] = useState<string | null>(null);

  const tools = (data?.tools ?? []) as CatalogTool[];

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tools;
    return tools.filter(
      (tool) =>
        tool.name.toLowerCase().includes(q) ||
        tool.description?.toLowerCase().includes(q),
    );
  }, [tools, query]);

  const selected =
    filtered.find((tool) => tool.name === selectedName) ?? filtered[0] ?? null;

  if (isLoading) return <SimpleLoading />;
  if (error) {
    return (
      <Description className="text-destructive">
        Failed to load MCP catalog: {error.message}
      </Description>
    );
  }

  return (
    <Stack gap="lg">
      {data?.instructions ? (
        <Card>
          <CardHeader>
            <CardTitle>Server instructions</CardTitle>
            <CardDescription>
              Workflow guidance exposed to MCP clients via tools/list metadata.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <pre className="whitespace-pre-wrap rounded-md bg-muted p-2 text-xs leading-relaxed">
              {data.instructions}
            </pre>
          </CardContent>
        </Card>
      ) : null}

      <Row align="start" gap="lg" className="items-start">
        <Card className="w-full max-w-sm shrink-0">
          <CardHeader>
            <CardTitle>Tools</CardTitle>
            <CardDescription>{tools.length} registered tools</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
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
                  className={`block w-full rounded-md px-2 py-2 text-left text-sm transition-colors hover:bg-muted ${
                    selected?.name === tool.name ? "bg-muted font-medium" : ""
                  }`}
                >
                  {tool.name}
                </button>
              ))}
            </div>
          </CardContent>
        </Card>

        {selected ? (
          <Stack className="min-w-0 flex-1" gap="md">
            <Card>
              <CardHeader>
                <CardTitle>{selected.name}</CardTitle>
                {selected.description ? (
                  <CardDescription>{selected.description}</CardDescription>
                ) : null}
              </CardHeader>
              <CardContent className="space-y-2">
                <AnnotationBadges tool={selected} />
                {selected.inputSchema && schemaHasMock(selected.inputSchema) ? (
                  <Badge variant="destructive">Contains mock metadata</Badge>
                ) : null}
                {selected.annotations ? (
                  <pre className="rounded-md bg-muted p-2 text-xs leading-relaxed">
                    {JSON.stringify(selected.annotations, null, 2)}
                  </pre>
                ) : null}
              </CardContent>
            </Card>

            <SchemaPanel title="INPUT SCHEMA" schema={selected.inputSchema} />
            <SchemaPanel title="OUTPUT SCHEMA" schema={selected.outputSchema} />
          </Stack>
        ) : (
          <Description>Select a tool to inspect its schemas.</Description>
        )}
      </Row>
    </Stack>
  );
}
