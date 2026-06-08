import { ActivityIndicator, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { InventoryList } from "@/components/inventory-list";
import { SignIn } from "@/components/sign-in";
import { authClient } from "@/lib/auth-client";

export default function HomeScreen() {
  const { data: session, isPending } = authClient.useSession();

  if (isPending) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.flex} edges={["top"]}>
      {session ? <InventoryList /> : <SignIn />}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
});
