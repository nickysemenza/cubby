import { QueryClientProvider } from "@tanstack/react-query";
import { Redirect, Stack, useSegments } from "expo-router";
import { View } from "react-native";

import { authClient } from "@/lib/auth";
import { queryClient } from "@/lib/api";

function useProtectedRoute() {
  const { data: session, isPending } = authClient.useSession();
  const segments = useSegments();

  if (isPending) return { isLoading: true, redirect: null } as const;

  const inAuthGroup = segments[0] === "(auth)";

  if (!session && !inAuthGroup) {
    return { isLoading: false, redirect: "/(auth)/sign-in" } as const;
  }
  if (session && inAuthGroup) {
    return { isLoading: false, redirect: "/(tabs)/scan" } as const;
  }

  return { isLoading: false, redirect: null } as const;
}

function AuthGate({ children }: { children: React.ReactNode }) {
  const { isLoading, redirect } = useProtectedRoute();

  if (isLoading) return null;
  if (redirect) return <Redirect href={redirect} />;

  return <>{children}</>;
}

export default function RootLayout() {
  return (
    <View style={{ flex: 1 }}>
      <QueryClientProvider client={queryClient}>
        <AuthGate>
          <Stack screenOptions={{ headerShown: false }}>
            <Stack.Screen name="index" />
            <Stack.Screen name="(auth)" />
            <Stack.Screen name="(tabs)" />
            <Stack.Screen
              name="product/[id]"
              options={{ headerShown: true, title: "Product" }}
            />
            <Stack.Screen name="location" options={{ headerShown: false }} />
            <Stack.Screen name="recipe" options={{ headerShown: false }} />
            <Stack.Screen name="ingredient" options={{ headerShown: false }} />
            <Stack.Screen
              name="inventory-list"
              options={{ headerShown: true, title: "Inventory" }}
            />
            <Stack.Screen
              name="activity"
              options={{ headerShown: true, title: "Activity" }}
            />
          </Stack>
        </AuthGate>
      </QueryClientProvider>
    </View>
  );
}
