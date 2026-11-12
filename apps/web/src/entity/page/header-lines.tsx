import { SparkleIcon } from "@phosphor-icons/react/dist/csr/Sparkle";
import type { ReactNode } from "react";

/**
 * The record header's declared lines and, when the record has one, its
 * labelled AI-written summary. Explanation lines sit in a 64px label column;
 * when any line carries a figure (a number field) the lines draw as key facts
 * instead, each label over its value. From 1120px of pane width the lines and
 * the summary sit side by side; narrower, the summary follows.
 */
export function HeaderLines({
  lines,
  aiSummary,
}: {
  lines: ReadonlyArray<{ label: string; value: ReactNode; figure?: boolean }>;
  aiSummary?: { text: string; attribution: string } | null;
}) {
  if (lines.length === 0 && !aiSummary) return null;
  const figures = lines.some((line) => line.figure);
  return (
    <div className="@container/header">
      <div
        data-header-lines
        className="grid gap-x-10 gap-y-3 py-2.5 text-sm @min-[1120px]/header:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"
      >
        {lines.length === 0 ? null : figures ? (
          <dl className="flex min-w-0 flex-wrap content-start gap-x-8 gap-y-2 pb-1">
            {lines.map((line) => (
              <div key={line.label} className="grid min-w-0 gap-0.5">
                <dt className="text-2xs text-muted-foreground">{line.label}</dt>
                <dd
                  className={
                    line.figure
                      ? "font-mono text-base/5 font-semibold text-foreground-strong tabular-nums"
                      : "text-sm/5 font-medium text-foreground-strong"
                  }
                >
                  {line.value}
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          <dl className="grid min-w-0 grid-cols-[4rem_minmax(0,1fr)] content-start gap-x-3 gap-y-1">
            {lines.map((line) => (
              <div key={line.label} className="contents">
                <dt className="text-muted-foreground">{line.label}</dt>
                <dd className="min-w-0 break-words text-foreground">
                  {line.value}
                </dd>
              </div>
            ))}
          </dl>
        )}
        {aiSummary ? (
          <section
            aria-label="AI-written summary"
            className="max-w-prose min-w-0"
          >
            <p className="mb-0.5 flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
              <SparkleIcon
                aria-hidden
                weight="bold"
                className="size-3 shrink-0"
              />
              {aiSummary.attribution}
            </p>
            <div className="space-y-2 whitespace-pre-line text-foreground">
              {aiSummary.text}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}
