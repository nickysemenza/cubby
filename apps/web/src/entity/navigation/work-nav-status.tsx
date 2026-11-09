import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";
import { useQuery } from "@tanstack/react-query";

import { workQueue } from "~/integrations/tanstack-query/generated/domains/workQueue.gen";
import { formatCount } from "~/lib/number-format";

/**
 * Quiet by default: healthy work shows nothing at any backlog size, and a failed
 * read claims nothing here because the page itself says the status is unknown.
 * It never polls; this read must not keep a scale-to-zero database awake.
 */
function useWorkNavStatus() {
  const { data } = useQuery({
    ...workQueue.status.queryOptions({}),
    refetchInterval: false,
  });
  return {
    needsYou: data?.needsYou.count ?? 0,
    stuck: Boolean(data?.stuck.length),
  };
}

/** The Work row's trailing signal: a static warning glyph, then the needs-you count. */
export function WorkNavStatus() {
  const { needsYou, stuck } = useWorkNavStatus();
  if (!needsYou && !stuck) return null;
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1 pl-1 font-mono text-xs text-foreground-strong tabular-nums">
      {stuck ? (
        <>
          <WarningIcon
            aria-hidden
            className="size-3.5 shrink-0 text-warning-ink"
          />
          <span className="sr-only">background work stuck</span>
        </>
      ) : null}
      {needsYou ? (
        <>
          <span aria-hidden="true">{formatCount(needsYou)}</span>
          <span className="sr-only">{formatCount(needsYou)} need you</span>
        </>
      ) : null}
    </span>
  );
}

/** The collapsed rail's form of the same signal, labelled for its icon-only link. */
export function WorkNavDot() {
  const { needsYou, stuck } = useWorkNavStatus();
  if (!needsYou && !stuck) return null;
  return (
    <span
      className={`absolute top-1 right-1 size-1.5 rounded-full ${stuck ? "bg-warning-ink" : "bg-foreground-strong"}`}
    >
      <span className="sr-only">
        {[
          needsYou ? `${formatCount(needsYou)} need you` : null,
          stuck ? "background work stuck" : null,
        ]
          .filter(Boolean)
          .join(", ")}
      </span>
    </span>
  );
}
