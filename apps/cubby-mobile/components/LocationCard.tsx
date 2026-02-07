import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import {
  type LocationType,
  colors,
  getLocationTypeColor,
  withOpacity,
} from "@cubby/shared";
import { Image, StyleSheet, Text, TouchableOpacity, View } from "react-native";

import { LocationTypeBadge } from "./LocationTypeBadge";

type Props = {
  name: string;
  type: string;
  imageUrl?: string | null;
  itemCount: number;
  childCount: number;
  onPress: () => void;
};

export function LocationCard({
  name,
  type,
  imageUrl,
  itemCount,
  childCount,
  onPress,
}: Props) {
  const typeColor = getLocationTypeColor(type as LocationType);

  return (
    <TouchableOpacity
      style={[styles.card, { borderColor: withOpacity(typeColor, 0.3) }]}
      onPress={onPress}
    >
      {imageUrl ? (
        <Image source={{ uri: imageUrl }} style={styles.image} />
      ) : (
        <View
          style={[
            styles.iconPlaceholder,
            { backgroundColor: withOpacity(typeColor, 0.1) },
          ]}
        >
          <MaterialIcons name="place" size={32} color={typeColor} />
        </View>
      )}
      <View style={styles.info}>
        <Text style={styles.name} numberOfLines={1}>
          {name}
        </Text>
        <LocationTypeBadge type={type as LocationType} />
        <Text style={styles.subtitle}>
          {itemCount > 0 ? `${itemCount} items` : ""}
          {itemCount > 0 && childCount > 0 ? " · " : ""}
          {childCount > 0 ? `${childCount} sub-locations` : ""}
          {itemCount === 0 && childCount === 0 ? "Empty" : ""}
        </Text>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    flex: 1,
    margin: 6,
    borderRadius: 10,
    borderWidth: 1,
    backgroundColor: "#fff",
    overflow: "hidden",
  },
  image: {
    width: "100%",
    height: 100,
    backgroundColor: colors.muted,
  },
  iconPlaceholder: {
    width: "100%",
    height: 100,
    alignItems: "center",
    justifyContent: "center",
  },
  info: { padding: 8, gap: 4 },
  name: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.foreground,
  },
  subtitle: {
    fontSize: 12,
    color: colors.mutedForeground,
    marginTop: 2,
  },
});
