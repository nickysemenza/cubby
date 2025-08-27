import { cva } from "class-variance-authority";
import { Badge } from "~/components/ui/badge";
import { type ImageStatus } from "~/schemas/image";

const statusBadgeVariants = cva("", {
  variants: {
    status: {
      UPLOADED: "bg-green-500 hover:bg-green-600",
      PENDING: "border-yellow-600 text-yellow-700",
      FAILED: "border-red-600 text-red-700",
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
