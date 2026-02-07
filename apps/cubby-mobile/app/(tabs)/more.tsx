import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { colors } from "@cubby/shared";
import { useRouter } from "expo-router";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";

type MenuItem = {
  title: string;
  description: string;
  icon: keyof typeof MaterialIcons.glyphMap;
  route: string;
};

const MENU_ITEMS: MenuItem[] = [
  {
    title: "Activity",
    description: "Recent changes and updates",
    icon: "history",
    route: "/activity",
  },
  {
    title: "Inventory",
    description: "All inventory items across locations",
    icon: "list-alt",
    route: "/inventory-list",
  },
];

export default function MoreScreen() {
  const router = useRouter();

  return (
    <View style={styles.container}>
      {MENU_ITEMS.map((item) => (
        <TouchableOpacity
          key={item.route}
          style={styles.row}
          onPress={() => router.push(item.route)}
        >
          <View style={styles.iconContainer}>
            <MaterialIcons
              name={item.icon}
              size={24}
              color={colors.terracotta}
            />
          </View>
          <View style={styles.text}>
            <Text style={styles.title}>{item.title}</Text>
            <Text style={styles.description}>{item.description}</Text>
          </View>
          <MaterialIcons
            name="chevron-right"
            size={24}
            color={colors.mutedForeground}
          />
        </TouchableOpacity>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.cream, paddingTop: 8 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  iconContainer: {
    width: 40,
    height: 40,
    borderRadius: 8,
    backgroundColor: `${colors.terracotta}15`,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 12,
  },
  text: { flex: 1 },
  title: { fontSize: 16, fontWeight: "600", color: colors.foreground },
  description: { fontSize: 14, color: colors.shelf, marginTop: 2 },
});
