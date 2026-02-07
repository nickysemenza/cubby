import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { colors } from "@cubby/shared";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";

type Props = {
  action: string;
  entityType: string;
  entityId: string;
  changes?: Record<string, unknown> | null;
  createdAt: Date;
  userName?: string | null;
  onPress?: () => void;
};

const ACTION_COLORS: Record<string, string> = {
  create: "hsl(140, 50%, 42%)",
  update: "hsl(210, 60%, 50%)",
  delete: colors.destructive,
};

const ENTITY_ICONS: Record<string, keyof typeof MaterialIcons.glyphMap> = {
  product: "inventory-2",
  location: "place",
  inventory: "list-alt",
  recipe: "restaurant-menu",
  ingredient: "eco",
};

function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60_000);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;

  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString();
}

export function ActivityEntry({
  action,
  entityType,
  createdAt,
  userName,
  onPress,
}: Props) {
  const actionColor = ACTION_COLORS[action] ?? colors.shelf;
  const icon = ENTITY_ICONS[entityType] ?? "help-outline";

  const actionVerb =
    action === "create"
      ? "Created"
      : action === "update"
        ? "Updated"
        : action === "delete"
          ? "Deleted"
          : action;

  return (
    <TouchableOpacity
      style={styles.container}
      onPress={onPress}
      disabled={!onPress}
    >
      <View
        style={[styles.iconContainer, { backgroundColor: `${actionColor}18` }]}
      >
        <MaterialIcons name={icon} size={20} color={actionColor} />
      </View>
      <View style={styles.content}>
        <Text style={styles.text}>
          <Text style={[styles.action, { color: actionColor }]}>
            {actionVerb}
          </Text>{" "}
          <Text style={styles.entityType}>{entityType}</Text>
        </Text>
        <View style={styles.meta}>
          <Text style={styles.time}>{formatRelativeTime(createdAt)}</Text>
          {userName && <Text style={styles.user}> · {userName}</Text>}
        </View>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  iconContainer: {
    width: 36,
    height: 36,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 12,
  },
  content: { flex: 1 },
  text: { fontSize: 15, color: colors.foreground },
  action: { fontWeight: "600" },
  entityType: { textTransform: "capitalize" },
  meta: { flexDirection: "row", marginTop: 4 },
  time: { fontSize: 13, color: colors.mutedForeground },
  user: { fontSize: 13, color: colors.mutedForeground },
});
