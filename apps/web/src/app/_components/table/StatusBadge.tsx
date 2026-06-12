import type { ImageStatus } from "@cubby/schemas/image";
import { cva } from "class-variance-authority";
import { Badge } from "~/components/ui/badge";

const statusBadgeVariants = cva("", {
  variants: {
    status: {
      UPLOADED: "bg-warning text-accent-foreground hover:bg-warning/80",
      PENDING: "border-muted-foreground text-muted-foreground",
      FAILED: "border-destructive text-destructive",
    },
  },
  defaultVariants: {
    status: "PENDING",
  },
});

interface StatusBadgeProps {
  status: ImageStatus;
  children?: React.ReactNode;
}

export const ImageStatusBadge = ({ status, children }: StatusBadgeProps) => {
  const variant = status === "UPLOADED" ? "default" : "outline";

  return (
    <Badge variant={variant} className={statusBadgeVariants({ status })}>
      {children || status}
    </Badge>
  );
};
