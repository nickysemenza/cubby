import { router } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

const SECTIONS = [
  { label: "Products", route: "/products", icon: "📦" },
  { label: "Ingredients", route: "/ingredients", icon: "🥕" },
  { label: "Cookbooks", route: "/cookbooks", icon: "📚" },
  { label: "Locations", route: "/locations", icon: "🗺️" },
] as const;

export default function BrowseScreen() {
  return (
    <SafeAreaView style={styles.flex} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.title}>Browse</Text>
      </View>
      <View style={styles.list}>
        {SECTIONS.map((s) => (
          <Pressable
            key={s.route}
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            onPress={() => router.push(s.route)}
          >
            <Text style={styles.icon}>{s.icon}</Text>
            <Text style={styles.label}>{s.label}</Text>
            <Text style={styles.chevron}>›</Text>
          </Pressable>
        ))}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: "#fff" },
  header: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12 },
  title: { fontSize: 28, fontWeight: "800" },
  list: { paddingHorizontal: 16 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#ddd",
  },
  rowPressed: { opacity: 0.55 },
  icon: { fontSize: 22 },
  label: { fontSize: 17, fontWeight: "600", flex: 1 },
  chevron: { fontSize: 24, color: "#c4c4c4" },
});
