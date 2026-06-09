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
  /** Make the title tappable (e.g. navigate to the underlying product). */
  onTitlePress?: () => void;
  /** Make the subtitle tappable (e.g. navigate to the location). */
  onSubtitlePress?: () => void;
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
  onTitlePress,
  onSubtitlePress,
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
      {title ? (
        onTitlePress ? (
          <Pressable
            style={({ pressed }) => [styles.linkRow, pressed && styles.pressed]}
            onPress={onTitlePress}
          >
            <Text style={[styles.title, styles.linkText]}>{title}</Text>
            <Text style={styles.linkChevron}>›</Text>
          </Pressable>
        ) : (
          <Text style={styles.title}>{title}</Text>
        )
      ) : null}
      {subtitle ? (
        onSubtitlePress ? (
          <Pressable
            style={({ pressed }) => [styles.linkRow, pressed && styles.pressed]}
            onPress={onSubtitlePress}
          >
            <Text style={[styles.subtitle, styles.linkText]}>{subtitle}</Text>
            <Text style={styles.linkChevronSm}>›</Text>
          </Pressable>
        ) : (
          <Text style={styles.subtitle}>{subtitle}</Text>
        )
      ) : null}

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

/** A text line for lists like ingredients/instructions; tappable when onPress set. */
export function DetailLine({
  children,
  onPress,
}: {
  children: ReactNode;
  onPress?: () => void;
}) {
  if (!onPress) return <Text style={styles.line}>{children}</Text>;
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.lineRow, pressed && styles.pressed]}
    >
      <Text style={[styles.line, styles.lineFlex]}>{children}</Text>
      <Text style={styles.lineChevron}>›</Text>
    </Pressable>
  );
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
    height: 180,
    borderRadius: 14,
    backgroundColor: "#f0f0f0",
    marginBottom: 10,
  },
  title: { fontSize: 24, fontWeight: "800" },
  subtitle: { fontSize: 16, color: "#666", marginTop: 1 },
  linkRow: { flexDirection: "row", alignItems: "center" },
  linkText: { color: "#208AEF" },
  linkChevron: { fontSize: 22, color: "#208AEF", marginLeft: 4 },
  linkChevronSm: { fontSize: 18, color: "#208AEF", marginLeft: 4 },
  pressed: { opacity: 0.55 },
  rows: { marginTop: 12, gap: 0 },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 9,
    gap: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#eee",
  },
  label: { fontSize: 15, color: "#888" },
  value: { fontSize: 15, fontWeight: "600", flexShrink: 1, textAlign: "right" },
  section: { marginTop: 18, gap: 4 },
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
  lineRow: {
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#f0f0f0",
  },
  lineFlex: { flex: 1 },
  lineChevron: { fontSize: 18, color: "#ccc", marginLeft: 8 },
  error: { color: "#c0392b", paddingHorizontal: 24, textAlign: "center" },
  muted: { color: "#666" },
});
