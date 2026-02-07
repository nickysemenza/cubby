import { colors } from "@cubby/shared";
import { Link, Stack } from "expo-router";
import { StyleSheet, Text, View } from "react-native";

export default function NotFoundScreen() {
  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: "Oops!" }} />
      <Text style={styles.title}>{"This screen doesn't exist."}</Text>
      <Link href="/" style={styles.link}>
        <Text style={styles.linkText}>Go to home screen!</Text>
      </Link>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.cream,
  },
  title: { fontSize: 20, fontWeight: "bold", color: colors.foreground },
  link: { marginTop: 16, paddingTop: 16 },
  linkText: { fontSize: 16, color: colors.terracotta },
});
