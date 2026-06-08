import { DarkTheme, DefaultTheme, ThemeProvider } from "expo-router";
import { ActivityIndicator, useColorScheme, View } from "react-native";
import AppTabs from "@/components/app-tabs";
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
      <AppTabs />
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
