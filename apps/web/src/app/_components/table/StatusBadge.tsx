import { cva } from "class-variance-authority";
import { Badge } from "~/components/ui/badge";
import { type ImageStatus } from "~/schemas/image";

const statusBadgeVariants = cva("", {
  variants: {
    status: {
      UPLOADED: "bg-accent text-accent-foreground hover:bg-accent/80",
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
