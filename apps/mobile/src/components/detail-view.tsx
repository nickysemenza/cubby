import { Image } from "expo-image";
import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
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
  /** Custom sections rendered below the label/value rows. */
  children?: ReactNode;
};

/** Shared scrollable detail layout: hero image, title/subtitle, rows, sections. */
export function DetailView({
  isLoading,
  error,
  notFound,
  title,
  subtitle,
  imageUrl,
  rows,
  children,
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

      {visible.length ? (
        <View style={styles.rows}>
          {visible.map((r) => (
            <View key={r.label} style={styles.row}>
              <Text style={styles.label}>{r.label}</Text>
              <Text style={styles.value}>{r.value}</Text>
            </View>
          ))}
        </View>
      ) : null}

      {children}
    </ScrollView>
  );
}

/** A titled section for custom detail content (e.g. ingredients, contents). */
export function DetailSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

/** A tappable row used inside sections (e.g. a child location, a sub-recipe). */
export function DetailNavRow({
  label,
  sublabel,
  onPress,
}: {
  label: string;
  sublabel?: string | null;
  onPress: () => void;
}) {
  return (
    <Pressable
      style={({ pressed }) => [styles.navRow, pressed && styles.navRowPressed]}
      onPress={onPress}
    >
      <View style={{ flex: 1 }}>
        <Text style={styles.navLabel} numberOfLines={1}>
          {label}
        </Text>
        {sublabel ? (
          <Text style={styles.navSub} numberOfLines={1}>
            {sublabel}
          </Text>
        ) : null}
      </View>
      <Text style={styles.chevron}>›</Text>
    </Pressable>
  );
}

/** A plain (non-tappable) text line for lists like ingredients/instructions. */
export function DetailLine({ children }: { children: ReactNode }) {
  return <Text style={styles.line}>{children}</Text>;
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: "#fff" },
  content: { padding: 16, gap: 4, paddingBottom: 40 },
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
  section: { marginTop: 24, gap: 4 },
  sectionTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: "#999",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  navRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#eee",
  },
  navRowPressed: { opacity: 0.55 },
  navLabel: { fontSize: 16, fontWeight: "600" },
  navSub: { fontSize: 13, color: "#888", marginTop: 2 },
  chevron: { fontSize: 24, color: "#c4c4c4", marginLeft: 8 },
  line: { fontSize: 15, lineHeight: 22, color: "#333", paddingVertical: 3 },
  error: { color: "#c0392b", paddingHorizontal: 24, textAlign: "center" },
  muted: { color: "#666" },
});
