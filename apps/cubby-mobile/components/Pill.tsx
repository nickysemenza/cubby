import { StyleSheet, Text, View } from "react-native";
import { withOpacity } from "@cubby/shared";

interface PillProps {
  label: string;
  color: string;
}

export function Pill({ label, color }: PillProps) {
  return (
    <View
      style={[
        styles.pill,
        { borderColor: color, backgroundColor: withOpacity(color, 0.15) },
      ]}
    >
      <Text style={[styles.label, { color }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    alignSelf: "flex-start",
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  label: {
    fontSize: 12,
    fontWeight: "500",
  },
});
