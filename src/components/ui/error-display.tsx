import { AlertCircle } from "lucide-react";

interface ErrorDisplayProps {
  error: unknown;
  className?: string;
}

export function ErrorDisplay({ error, className }: ErrorDisplayProps) {
  const isErrorWithData = (
    err: unknown,
  ): err is { data?: { code?: string }; message?: string } => {
    return typeof err === "object" && err !== null;
  };

  const typedError = isErrorWithData(error) ? error : null;

  return (
    <div
      className={`flex items-center justify-center gap-2 text-red-600 ${className || ""}`}
    >
      <AlertCircle className="h-4 w-4" />
      <span>
        {typedError?.data?.code === "UNAUTHORIZED"
          ? "Please sign in to continue"
          : typedError?.message || "An error occurred"}
      </span>
    </div>
  );
}
