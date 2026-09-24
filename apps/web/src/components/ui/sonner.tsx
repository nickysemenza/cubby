import { Toaster as Sonner, type ToasterProps } from "sonner";
import { CheckCircleIcon as CircleCheckIcon } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { InfoIcon } from "@phosphor-icons/react/dist/csr/Info";
import { WarningIcon as TriangleAlertIcon } from "@phosphor-icons/react/dist/csr/Warning";
import { WarningOctagonIcon as OctagonXIcon } from "@phosphor-icons/react/dist/csr/WarningOctagon";
import { CircleNotchIcon as Loader2Icon } from "@phosphor-icons/react/dist/csr/CircleNotch";

const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="light"
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "cn-toast",
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
