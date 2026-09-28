export function TechnicalError({
  error,
  prefix,
  tone = "destructive",
}: {
  error: string;
  prefix?: string;
  tone?: "destructive" | "muted";
}) {
  const [summary] = error.split("\n", 1);
  const hasDetails = error.includes("\n");
  return (
    <div className="min-w-0 text-sm">
      <p
        role={tone === "destructive" ? "alert" : undefined}
        className={tone === "destructive" ? "text-destructive" : "text-muted-foreground"}
      >
        {prefix}{summary}
      </p>
      {hasDetails ? (
        <details className="mt-1 text-muted-foreground">
          <summary className="w-fit cursor-pointer font-medium hover:text-foreground">
            Technical details
          </summary>
          <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-3 font-mono text-xs text-foreground">
            {error}
          </pre>
        </details>
      ) : null}
    </div>
  );
}
