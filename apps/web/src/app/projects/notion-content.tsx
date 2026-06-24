import { useQuery } from "@tanstack/react-query";
import { CheckSquare, Square } from "lucide-react";
import { Row, Stack } from "~/components/layout";
import type { NotionBlock } from "~/server/clients/notion";
import { useTRPC } from "~/trpc/react";

export function NotionPageContent({ pageId }: { pageId: string }) {
  const api = useTRPC();
  const { data: blocks, isLoading } = useQuery({
    ...api.notion.projectContent.queryOptions({ pageId }),
    staleTime: 5 * 60 * 1000,
  });

  if (isLoading) {
    return (
      <Stack gap="sm">
        <div className="h-4 w-3/4 animate-pulse rounded bg-muted" />
        <div className="h-4 w-1/2 animate-pulse rounded bg-muted" />
      </Stack>
    );
  }

  if (!blocks || blocks.length === 0) return null;

  return (
    <div className="prose prose-sm max-w-none">
      <BlockList blocks={blocks} />
    </div>
  );
}

function BlockList({ blocks }: { blocks: NotionBlock[] }) {
  const elements: React.ReactNode[] = [];
  let i = 0;

  while (i < blocks.length) {
    const block = blocks[i]!;

    // Group consecutive list items
    if (block.type === "bulleted_list_item") {
      const items: NotionBlock[] = [];
      while (i < blocks.length && blocks[i]!.type === "bulleted_list_item") {
        items.push(blocks[i]!);
        i++;
      }
      elements.push(
        <ul key={`ul-${i}`} className="list-disc space-y-1 pl-4">
          {items.map((item, j) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static parsed Notion content, never reordered; blocks have no id
            <li key={j}>{item.text}</li>
          ))}
        </ul>,
      );
      continue;
    }

    if (block.type === "numbered_list_item") {
      const items: NotionBlock[] = [];
      while (i < blocks.length && blocks[i]!.type === "numbered_list_item") {
        items.push(blocks[i]!);
        i++;
      }
      elements.push(
        <ol key={`ol-${i}`} className="list-decimal space-y-1 pl-4">
          {items.map((item, j) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static parsed Notion content, never reordered; blocks have no id
            <li key={j}>{item.text}</li>
          ))}
        </ol>,
      );
      continue;
    }

    if (block.type === "to_do") {
      const items: NotionBlock[] = [];
      while (i < blocks.length && blocks[i]!.type === "to_do") {
        items.push(blocks[i]!);
        i++;
      }
      elements.push(
        <Stack key={`todo-${i}`} gap="xs">
          {items.map((item, j) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static parsed Notion content, never reordered; blocks have no id
            <Row key={j} align="center" gap="sm">
              {item.checked ? (
                <CheckSquare className="h-4 w-4 shrink-0 text-positive" />
              ) : (
                <Square className="h-4 w-4 shrink-0 text-muted-foreground" />
              )}
              <span
                className={
                  item.checked ? "text-muted-foreground line-through" : ""
                }
              >
                {item.text}
              </span>
            </Row>
          ))}
        </Stack>,
      );
      continue;
    }

    elements.push(<BlockRenderer key={i} block={block} />);
    i++;
  }

  return <>{elements}</>;
}

function BlockRenderer({ block }: { block: NotionBlock }) {
  switch (block.type) {
    case "paragraph":
      if (!block.text) return <div className="h-4" />;
      return <p>{block.text}</p>;
    case "heading_1":
      return <h2 className="mt-4 font-bold text-lg">{block.text}</h2>;
    case "heading_2":
      return <h3 className="mt-2 font-semibold text-base">{block.text}</h3>;
    case "heading_3":
      return <h4 className="mt-2 font-medium text-sm">{block.text}</h4>;
    case "image":
      if (!block.imageUrl) return null;
      return (
        <img
          src={block.imageUrl}
          alt=""
          className="max-h-[400px] rounded-lg object-contain"
          loading="lazy"
        />
      );
    case "divider":
      return <hr className="my-4" />;
    case "child_page":
      return (
        <Row
          align="center"
          gap="sm"
          className="rounded-md border px-4 py-2 text-sm"
        >
          <span className="text-muted-foreground">📄</span>
          <span className="font-medium">{block.text}</span>
        </Row>
      );
    case "child_database":
      return (
        <Row
          align="center"
          gap="sm"
          className="rounded-md border px-4 py-2 text-sm"
        >
          <span className="text-muted-foreground">🗃️</span>
          <span className="font-medium">{block.text}</span>
        </Row>
      );
    case "quote":
      return (
        <blockquote className="border-muted-foreground/30 border-l-2 pl-4 text-muted-foreground italic">
          {block.text}
        </blockquote>
      );
    case "callout":
      return (
        <div className="rounded-md bg-muted/50 px-4 py-4 text-sm">
          {block.text}
        </div>
      );
    case "code":
      return (
        <pre className="overflow-x-auto rounded-md bg-muted p-4 text-xs">
          <code>{block.text}</code>
        </pre>
      );
    case "bookmark":
    case "embed":
      if (!block.text) return null;
      return (
        <a
          href={block.text}
          target="_blank"
          rel="noopener noreferrer"
          className="block truncate text-primary text-sm hover:underline"
        >
          {block.text}
        </a>
      );
    case "toggle":
      return (
        <details className="text-sm">
          <summary className="cursor-pointer font-medium">{block.text}</summary>
        </details>
      );
    case "columns":
      if (!block.children) return null;
      return (
        <div className="grid grid-cols-2 gap-4">
          {block.children.map((child, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static parsed Notion column blocks, never reordered; blocks have no id
            <BlockRenderer key={i} block={child} />
          ))}
        </div>
      );
    default:
      return null;
  }
}
