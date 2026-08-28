import { type ReactNode, Suspense } from "react";

import { Description } from "~/components/ui/description";

interface VisualizationPanelProps {
  title: string;
  description?: string;
  fallback: ReactNode;
  children: ReactNode;
}

export function VisualizationPanel({
  title,
  description,
  fallback,
  children,
}: VisualizationPanelProps) {
  return (
    <div>
      <h3 className="mb-2 text-lg font-semibold">{title}</h3>
      {description && <Description className="mb-4">{description}</Description>}
      <Suspense fallback={fallback}>{children}</Suspense>
    </div>
  );
}
