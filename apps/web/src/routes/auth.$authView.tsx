import { AuthView } from "@daveyplate/better-auth-ui";
import { createFileRoute } from "@tanstack/react-router";
import {
  Apple,
  Carrot,
  ChefHat,
  CookingPot,
  Milk,
  Package,
  Salad,
  Sandwich,
  UtensilsCrossed,
  Warehouse,
  Wheat,
} from "lucide-react";
import { z } from "zod";

const searchSchema = z.object({
  redirect: z.string().optional(),
});

export const Route = createFileRoute("/auth/$authView")({
  validateSearch: searchSchema,
  component: AuthPage,
});

const patternIcons = [
  Package,
  UtensilsCrossed,
  ChefHat,
  Carrot,
  CookingPot,
  Apple,
  Warehouse,
  Salad,
  Milk,
  Sandwich,
  Wheat,
];

// Seeded random for consistent positions across renders
const seededRandom = (seed: number) => {
  const x = Math.sin(seed * 9999) * 10000;
  return x - Math.floor(x);
};

function AuthPage() {
  const { authView } = Route.useParams();

  return (
    <div className="auth-background relative flex min-h-screen items-center justify-center overflow-hidden p-4">
      {/* Icon pattern overlay */}
      <div
        className="pointer-events-none absolute inset-0 overflow-hidden"
        aria-hidden="true"
      >
        <div className="absolute inset-0 grid grid-cols-12 gap-3 p-2 opacity-[0.04] md:grid-cols-16 md:gap-4">
          {Array.from({ length: 200 }).map((_, i) => {
            const iconIndex = Math.floor(
              seededRandom(i * 7) * patternIcons.length,
            );
            const Icon = patternIcons[iconIndex];
            const rotation = seededRandom(i * 13) * 40 - 20;
            const scale = 0.7 + seededRandom(i * 17) * 0.5;
            return (
              <Icon
                // biome-ignore lint/suspicious/noArrayIndexKey: static decorative pattern, order never changes
                key={i}
                className="h-5 w-5 text-foreground"
                style={{
                  transform: `rotate(${rotation}deg) scale(${scale})`,
                }}
              />
            );
          })}
        </div>
      </div>
      {/* Auth form */}
      <div className="relative z-10 w-full max-w-md">
        <AuthView pathname={authView} />
      </div>
    </div>
  );
}
