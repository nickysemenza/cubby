import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { InventoryList } from "@/components/inventory-list";
import { SignIn } from "@/components/sign-in";
import { authClient } from "@/lib/auth-client";
import { ensureApiKey } from "@/lib/session-key";

export default function HomeScreen() {
  const { data: session, isPending } = authClient.useSession();

  // Ensure the tRPC API key is minted+stored before rendering data so the first
  // query carries x-api-key (avoids a cold-start 401 when a session exists but no
  // key is stored yet, e.g. after reinstall).
  const [keyReady, setKeyReady] = useState(false);
  useEffect(() => {
    let active = true;
    if (!session) {
      setKeyReady(false);
      return;
    }
    void ensureApiKey().then(() => {
      if (active) setKeyReady(true);
    });
    return () => {
      active = false;
    };
  }, [session]);

  if (isPending) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  if (!session) {
    return (
      <SafeAreaView style={styles.flex} edges={["top"]}>
        <SignIn />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.flex} edges={["top"]}>
      {keyReady ? (
        <InventoryList />
      ) : (
        <View style={styles.center}>
          <ActivityIndicator size="large" />
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
});
