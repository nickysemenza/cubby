import Link from "next/link";
import { PackageOpen } from "lucide-react";

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center space-y-6 p-4">
      <div className="flex items-center space-x-3">
        <PackageOpen className="h-12 w-12" />
        <h1 className="text-4xl font-bold">404</h1>
      </div>
      <div className="space-y-2 text-center">
        <h2 className="text-2xl font-semibold">Page Not Found</h2>
        <p className="text-muted-foreground max-w-md">
          The page you&apos;re looking for doesn&apos;t exist or has been moved.
        </p>
      </div>
      <Link
        href="/"
        className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center justify-center rounded-md px-4 py-2 text-sm font-medium shadow transition-colors"
      >
        Return Home
      </Link>
    </div>
  );
}
