import { useQuery } from "@tanstack/react-query";
import { Stack, useLocalSearchParams } from "expo-router";
import {
  ActivityIndicator,
  Dimensions,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { api } from "@/lib/api";

const screenWidth = Dimensions.get("window").width;

export default function LocationDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();

  const { data: location, isLoading } = useQuery(
    api.location.getByID.queryOptions({ id: id! }),
  );

  if (isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  if (!location) {
    return (
      <View style={styles.center}>
        <Text style={styles.notFound}>Location not found</Text>
      </View>
    );
  }

  const images = location.images?.filter((img) => img.url) ?? [];

  return (
    <ScrollView style={styles.container}>
      <Stack.Screen options={{ title: location.name }} />
      {images.length > 0 && (
        <ScrollView
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          style={styles.imageScroller}
        >
          {images.map((img) => (
            <Image
              key={img.id}
              source={{ uri: img.url }}
              style={styles.heroImage}
              resizeMode="cover"
            />
          ))}
        </ScrollView>
      )}
      <View style={styles.content}>
        <Text style={styles.title}>{location.name}</Text>
        {location.shortcode && (
          <Detail label="Shortcode" value={location.shortcode} />
        )}
        {location.description && (
          <Detail label="Description" value={location.description} />
        )}
      </View>
    </ScrollView>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.detail}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.detailValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#fff",
  },
  imageScroller: { flexGrow: 0 },
  heroImage: {
    width: screenWidth,
    height: 250,
    backgroundColor: "#f3f4f6",
  },
  content: { padding: 16 },
  title: { fontSize: 24, fontWeight: "bold" },
  notFound: { color: "#9ca3af" },
  detail: { marginTop: 12 },
  detailLabel: { fontSize: 14, color: "#6b7280" },
  detailValue: { fontSize: 16 },
});
