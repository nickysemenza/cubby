import { useState } from "react";
import { ActivityIndicator, Text, TouchableOpacity } from "react-native";
import { authClient } from "@/lib/auth-client";

export function SignOutButton() {
  const [loading, setLoading] = useState(false);

  async function onPress() {
    setLoading(true);
    await authClient.signOut();
    // useSession() in the auth gate flips to signed-out and re-renders SignIn.
    setLoading(false);
  }

  return (
    <TouchableOpacity onPress={onPress} disabled={loading} hitSlop={8}>
      {loading ? (
        <ActivityIndicator />
      ) : (
        <Text style={{ color: "#208AEF", fontSize: 16, fontWeight: "600" }}>
          Sign out
        </Text>
      )}
    </TouchableOpacity>
  );
}
