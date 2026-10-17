import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import {
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { cn } from "~/lib/utils";
import { useHydrated } from "~/ui/hooks/use-hydrated";

export interface OutlineNode<T> {
  id: string;
  name: string;
  data: T;
  children?: OutlineNode<T>[];
}

function TreeMatch({ text, query = "" }: { text: string; query?: string }) {
  const term = query.trim().toLocaleLowerCase();
  const index = term ? text.toLocaleLowerCase().indexOf(term) : -1;
  if (index < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, index)}
      <mark className="bg-accent text-accent-foreground">
        {text.slice(index, index + term.length)}
      </mark>
      {text.slice(index + term.length)}
    </>
  );
}

/** Shared outline mechanics; callers own record identity, links and selection. */
export function TreeOutline<T>({
  nodes,
  label,
  expandedIds,
  onToggle,
  selectedId,
  onSelect,
  renderIcon,
  renderTrailing,
  renderAction,
  query,
  locked = false,
}: {
  nodes: OutlineNode<T>[];
  label: string;
  expandedIds: ReadonlySet<string>;
  onToggle: (id: string) => void;
  selectedId?: string;
  onSelect?: (id: string) => void;
  renderIcon?: (node: OutlineNode<T>) => ReactNode;
  renderTrailing?: (node: OutlineNode<T>) => ReactNode;
  renderAction?: (node: OutlineNode<T>, name: ReactNode) => ReactNode;
  query?: string;
  locked?: boolean;
}) {
  // Streamed sections can be visible before their own handlers hydrate.
  const hydrated = useHydrated();
  const [focusedId, setFocusedId] = useState<string>();
  const refs = useRef(new Map<string, HTMLDivElement>());
  const rows = useMemo(() => {
    const result: {
      node: OutlineNode<T>;
      depth: number;
      parent?: string;
      position: number;
      size: number;
    }[] = [];
    const visit = (items: OutlineNode<T>[], depth: number, parent?: string) => {
      items.forEach((node, index) => {
        result.push({
          node,
          depth,
          parent,
          position: index + 1,
          size: items.length,
        });
        if (expandedIds.has(node.id))
          visit(node.children ?? [], depth + 1, node.id);
      });
    };
    visit(nodes, 0);
    return result;
  }, [nodes, expandedIds]);
  const tabStop = rows.some(({ node }) => node.id === focusedId)
    ? focusedId
    : (rows.find(({ node }) => node.id === selectedId)?.node.id ??
      rows[0]?.node.id);

  const focus = (id?: string) => {
    if (!id) return;
    setFocusedId(id);
    refs.current.get(id)?.focus();
  };
  const handleKey = (event: KeyboardEvent<HTMLDivElement>, index: number) => {
    const row = rows[index];
    if (!row || event.altKey || event.ctrlKey || event.metaKey) return;
    const { node, parent } = row;
    switch (event.key) {
      case "ArrowDown":
        focus(rows[index + 1]?.node.id);
        break;
      case "ArrowUp":
        focus(rows[index - 1]?.node.id);
        break;
      case "Home":
        focus(rows[0]?.node.id);
        break;
      case "End":
        focus(rows.at(-1)?.node.id);
        break;
      case "ArrowRight":
        if (node.children?.length) {
          if (!expandedIds.has(node.id) && !locked) onToggle(node.id);
          else focus(node.children[0]?.id);
        }
        break;
      case "ArrowLeft":
        if (node.children?.length && expandedIds.has(node.id) && !locked)
          onToggle(node.id);
        else focus(parent);
        break;
      case "Enter":
      case " ":
        event.currentTarget
          .querySelector<HTMLElement>("[data-tree-action]")
          ?.click();
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <ul role="tree" aria-label={label} className="min-w-0 py-1">
      {rows.map(({ node, depth, position, size }, index) => {
        const branch = Boolean(node.children?.length);
        const expanded = expandedIds.has(node.id);
        const name = <TreeMatch text={node.name} query={query} />;
        return (
          <li key={node.id} role="none">
            <div
              role="treeitem"
              aria-label={node.name}
              aria-level={depth + 1}
              aria-posinset={position}
              aria-setsize={size}
              aria-expanded={branch ? expanded : undefined}
              aria-selected={onSelect ? selectedId === node.id : undefined}
              tabIndex={hydrated && tabStop === node.id ? 0 : -1}
              ref={(element) => {
                if (element) refs.current.set(node.id, element);
                else refs.current.delete(node.id);
              }}
              onFocus={() => setFocusedId(node.id)}
              onKeyDown={(event) => handleKey(event, index)}
              className={cn(
                "group/outline relative flex min-h-11 min-w-0 items-center gap-1 pr-2 text-xs hover:bg-muted/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary sm:min-h-7 [@media(pointer:coarse)]:min-h-11",
                selectedId === node.id && "bg-accent/40 font-medium",
              )}
              style={{ paddingInlineStart: `${4 + depth * 12}px` }}
            >
              {Array.from({ length: depth }, (_, level) => (
                <span
                  key={level}
                  aria-hidden
                  className="pointer-events-none absolute inset-y-0 border-l border-border/60"
                  style={{ insetInlineStart: `${14 + level * 12}px` }}
                />
              ))}
              {branch ? (
                <button
                  type="button"
                  tabIndex={-1}
                  aria-label={
                    locked
                      ? `${node.name} is expanded for ${query?.trim() ? "search" : "filters"}`
                      : `${expanded ? "Collapse" : "Expand"} ${node.name}`
                  }
                  aria-expanded={expanded}
                  disabled={locked || !hydrated}
                  onClick={() => {
                    focus(node.id);
                    onToggle(node.id);
                  }}
                  className="flex size-11 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground disabled:opacity-50 sm:size-5 [@media(pointer:coarse)]:size-11"
                >
                  <CaretRightIcon
                    aria-hidden
                    className={cn("size-3", expanded && "rotate-90")}
                  />
                </button>
              ) : (
                <span
                  aria-hidden
                  className="w-11 shrink-0 sm:w-5 [@media(pointer:coarse)]:w-11"
                />
              )}
              {renderIcon?.(node)}
              <div className="min-w-0 flex-1 [&_a]:flex [&_a]:min-h-11 [&_a]:items-center [&_a]:truncate [&_a]:outline-none sm:[&_a]:min-h-7 [@media(pointer:coarse)]:[&_a]:min-h-11">
                {renderAction ? (
                  renderAction(node, name)
                ) : (
                  <button
                    type="button"
                    disabled={!hydrated}
                    data-tree-action
                    tabIndex={-1}
                    aria-label={node.name}
                    onClick={() => onSelect?.(node.id)}
                    className="flex min-h-11 w-full items-center text-left sm:min-h-7 [@media(pointer:coarse)]:min-h-11"
                  >
                    <span className="truncate" title={node.name}>
                      {name}
                    </span>
                  </button>
                )}
              </div>
              {renderTrailing?.(node)}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
