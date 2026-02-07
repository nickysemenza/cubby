import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { colors, getErrorMessage } from "@cubby/shared";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

import { ImageCapture } from "@/components/ImageCapture";
import { LocationTypeBadge } from "@/components/LocationTypeBadge";
import { api, trpcClient } from "@/lib/api";

const screenWidth = Dimensions.get("window").width;

export default function LocationDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const queryClient = useQueryClient();
  const router = useRouter();

  const { data: location, isLoading } = useQuery(
    api.location.getByID.queryOptions({ id: id! }),
  );

  const updateMutation = useMutation({
    mutationFn: (pendingImageIds: string[]) =>
      trpcClient.location.update.mutate({
        id: id!,
        data: { pendingImageIds },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["location"] });
    },
    onError: (e) => {
      Alert.alert("Error", getErrorMessage(e));
    },
  });

  if (isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.terracotta} />
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
  const hasChildren =
    ((location as unknown as { children?: unknown[] }).children?.length ?? 0) >
    0;

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
        {location.type && (
          <View style={styles.badgeRow}>
            <LocationTypeBadge type={location.type} />
          </View>
        )}
        {location.shortcode && (
          <Detail label="Shortcode" value={location.shortcode} />
        )}
        {location.description && (
          <Detail label="Description" value={location.description} />
        )}

        {hasChildren && (
          <TouchableOpacity
            style={styles.validateButton}
            onPress={() => router.push(`/location/validate?parentId=${id}`)}
          >
            <MaterialIcons name="verified" size={20} color={colors.cream} />
            <Text style={styles.validateButtonText}>
              Validate Sub-Locations
            </Text>
          </TouchableOpacity>
        )}

        <ImageCapture
          entityType="LOCATION"
          onImageUploaded={(imageId) => updateMutation.mutate([imageId])}
        />
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
  container: { flex: 1, backgroundColor: colors.cream },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.cream,
  },
  imageScroller: { flexGrow: 0 },
  heroImage: {
    width: screenWidth,
    height: 250,
    backgroundColor: colors.muted,
  },
  content: { padding: 16 },
  title: { fontSize: 24, fontWeight: "bold", color: colors.foreground },
  badgeRow: { marginTop: 8 },
  notFound: { color: colors.mutedForeground },
  detail: { marginTop: 12 },
  detailLabel: { fontSize: 14, color: colors.shelf },
  detailValue: { fontSize: 16, color: colors.foreground },
  validateButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: colors.terracotta,
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 16,
    marginTop: 16,
  },
  validateButtonText: { color: colors.cream, fontWeight: "600", fontSize: 15 },
});
