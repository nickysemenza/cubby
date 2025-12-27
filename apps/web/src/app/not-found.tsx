import { PackageOpen } from "lucide-react";
import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center space-y-6 p-4">
      <div className="flex items-center space-x-3">
        <PackageOpen className="h-12 w-12" />
        <h1 className="font-bold text-4xl">404</h1>
      </div>
      <div className="space-y-2 text-center">
        <h2 className="font-semibold text-2xl">Page Not Found</h2>
        <p className="max-w-md text-muted-foreground">
          The page you&apos;re looking for doesn&apos;t exist or has been moved.
        </p>
      </div>
      <Link
        href="/"
        className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground text-sm shadow transition-colors hover:bg-primary/90"
      >
        Return Home
      </Link>
    </div>
  );
}
