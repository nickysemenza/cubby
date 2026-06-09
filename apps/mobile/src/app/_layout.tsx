import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from "expo-router";
import { ActivityIndicator, useColorScheme, View } from "react-native";
import { SignIn } from "@/components/sign-in";
import { authClient } from "@/lib/auth-client";
import { Providers } from "@/providers";

function AuthGate() {
  const colorScheme = useColorScheme();
  const { data: session, isPending } = authClient.useSession();

  if (isPending) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  if (!session) {
    return <SignIn />;
  }

  return (
    <ThemeProvider value={colorScheme === "dark" ? DarkTheme : DefaultTheme}>
      {/* Show only the chevron on back buttons (the previous screen is the
          untitled (tabs) group, which would otherwise read "(tabs)"). */}
      <Stack screenOptions={{ headerBackButtonDisplayMode: "minimal" }}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="products" options={{ title: "Products" }} />
        <Stack.Screen name="ingredients" options={{ title: "Ingredients" }} />
        <Stack.Screen name="cookbooks" options={{ title: "Cookbooks" }} />
        <Stack.Screen name="locations" options={{ title: "Locations" }} />
        <Stack.Screen name="purchases" options={{ title: "Purchases" }} />
        <Stack.Screen name="tasks" options={{ title: "Tasks" }} />
        <Stack.Screen name="product/[id]" options={{ title: "Product" }} />
        <Stack.Screen name="recipe/[id]" options={{ title: "Recipe" }} />
        <Stack.Screen
          name="ingredient/[id]"
          options={{ title: "Ingredient" }}
        />
        <Stack.Screen name="location/[id]" options={{ title: "Location" }} />
        <Stack.Screen name="inventory/[id]" options={{ title: "Item" }} />
        <Stack.Screen name="cookbook/[id]" options={{ title: "Cookbook" }} />
      </Stack>
    </ThemeProvider>
  );
}

export default function RootLayout() {
  return (
    <Providers>
      <AuthGate />
    </Providers>
  );
}
