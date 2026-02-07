import { colors, withOpacity } from "@cubby/shared";
import { StyleSheet, Text, View } from "react-native";

type Props = {
  title: string;
  count: number;
  color?: string;
};

export function SectionHeader({ title, count, color }: Props) {
  const accentColor = color ?? colors.terracotta;
  return (
    <View
      style={[
        styles.container,
        { backgroundColor: withOpacity(accentColor, 0.08) },
      ]}
    >
      <Text style={[styles.title, { color: accentColor }]}>{title}</Text>
      <View
        style={[
          styles.badge,
          { backgroundColor: withOpacity(accentColor, 0.15) },
        ]}
      >
        <Text style={[styles.badgeText, { color: accentColor }]}>{count}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  title: {
    fontSize: 14,
    fontWeight: "600",
    textTransform: "capitalize",
  },
  badge: {
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  badgeText: {
    fontSize: 12,
    fontWeight: "600",
  },
});
