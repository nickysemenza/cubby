import { Image } from "expo-image";
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

export type DetailRow = { label: string; value: string | null | undefined };

type DetailViewProps = {
  isLoading: boolean;
  error: { message: string } | null;
  notFound?: boolean;
  title?: string;
  subtitle?: string | null;
  imageUrl?: string | null;
  rows: DetailRow[];
};

/** Shared scrollable detail layout: hero image, title/subtitle, label/value rows. */
export function DetailView({
  isLoading,
  error,
  notFound,
  title,
  subtitle,
  imageUrl,
  rows,
}: DetailViewProps) {
  if (isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" />
      </View>
    );
  }
  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.error}>{error.message}</Text>
      </View>
    );
  }
  if (notFound) {
    return (
      <View style={styles.center}>
        <Text style={styles.muted}>Not found.</Text>
      </View>
    );
  }

  const visible = rows.filter((r) => r.value != null && r.value !== "");

  return (
    <ScrollView style={styles.flex} contentContainerStyle={styles.content}>
      {imageUrl ? (
        <Image
          style={styles.hero}
          source={{ uri: imageUrl }}
          contentFit="cover"
        />
      ) : null}
      {title ? <Text style={styles.title}>{title}</Text> : null}
      {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}

      <View style={styles.rows}>
        {visible.map((r) => (
          <View key={r.label} style={styles.row}>
            <Text style={styles.label}>{r.label}</Text>
            <Text style={styles.value}>{r.value}</Text>
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: "#fff" },
  content: { padding: 16, gap: 4 },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#fff",
  },
  hero: {
    width: "100%",
    height: 220,
    borderRadius: 14,
    backgroundColor: "#f0f0f0",
    marginBottom: 12,
  },
  title: { fontSize: 24, fontWeight: "800" },
  subtitle: { fontSize: 16, color: "#666", marginTop: 2 },
  rows: { marginTop: 16, gap: 2 },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 12,
    gap: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#eee",
  },
  label: { fontSize: 15, color: "#888" },
  value: { fontSize: 15, fontWeight: "600", flexShrink: 1, textAlign: "right" },
  error: { color: "#c0392b", paddingHorizontal: 24, textAlign: "center" },
  muted: { color: "#666" },
});
