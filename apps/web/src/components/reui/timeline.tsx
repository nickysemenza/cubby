import type { HTMLAttributes } from "react";
import { cn } from "~/lib/utils";

/** The audit log's chronological, vertical timeline. */
export function AuditTimeline({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} data-slot="timeline" className={cn("flex flex-col", className)}>{children}</div>;
}

export function AuditTimelineItem({ step: _step, className, children, ...props }: HTMLAttributes<HTMLDivElement> & { step: number }) {
  return <div {...props} data-slot="audit-timeline-item" className={cn("group/audit-timeline-item relative ms-8 flex flex-col gap-0.5 not-last:pb-6", className)}>{children}</div>;
}

export function AuditTimelineIndicator({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} aria-hidden data-slot="audit-timeline-indicator" className={cn("absolute -left-6 top-0 size-4 -translate-x-1/2 rounded-full border-2 border-primary/20", className)}>{children}</div>;
}

export function AuditTimelineSeparator({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} aria-hidden data-slot="audit-timeline-separator" className={cn("absolute -left-6 top-0 h-[calc(100%-1rem-0.25rem)] w-0.5 -translate-x-1/2 translate-y-4.5 self-start bg-primary/10 group-last/audit-timeline-item:hidden", className)}>{children}</div>;
}

export function AuditTimelineContent({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} data-slot="audit-timeline-content" className={cn("text-muted-foreground text-sm", className)}>{children}</div>;
}
