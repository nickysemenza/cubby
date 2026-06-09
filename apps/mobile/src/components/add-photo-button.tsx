import { getErrorMessage } from "@cubby/shared";
import { useQueryClient } from "@tanstack/react-query";
import * as ImagePicker from "expo-image-picker";
import { useState } from "react";
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useTRPCClient } from "@/lib/trpc";
import { uploadAndAttachToProduct } from "@/lib/upload-image";

/**
 * Nav-bar action: take/pick a photo, upload to R2, attach to the product.
 * `onUploaded` lets the host screen refetch its own query (more reliable than
 * cross-component cache invalidation); the list caches are invalidated too.
 */
export function AddPhotoButton({
  productId,
  onUploaded,
}: {
  productId: string;
  onUploaded?: () => void;
}) {
  const client = useTRPCClient();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);

  const run = async (fromCamera: boolean) => {
    const perm = fromCamera
      ? await ImagePicker.requestCameraPermissionsAsync()
      : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert(
        "Permission needed",
        fromCamera
          ? "Allow camera access in Settings to take a photo."
          : "Allow photo access in Settings to choose a photo.",
      );
      return;
    }
    const result = fromCamera
      ? await ImagePicker.launchCameraAsync({ quality: 0.7 })
      : await ImagePicker.launchImageLibraryAsync({
          quality: 0.7,
          mediaTypes: ["images"],
        });
    if (result.canceled) return;
    const asset = result.assets[0];
    if (!asset) return;

    setBusy(true);
    try {
      await uploadAndAttachToProduct(client, productId, asset);
      onUploaded?.();
      void qc.invalidateQueries({ queryKey: ["product", "list"] });
      void qc.invalidateQueries({ queryKey: ["inventory", "list"] });
    } catch (e) {
      Alert.alert("Upload failed", getErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const onPress = () => {
    if (busy) return;
    ActionSheetIOS.showActionSheetWithOptions(
      {
        options: ["Take Photo", "Choose from Library", "Cancel"],
        cancelButtonIndex: 2,
      },
      (i) => {
        if (i === 0) void run(true);
        else if (i === 1) void run(false);
      },
    );
  };

  return (
    <>
      <Pressable onPress={onPress} hitSlop={8} disabled={busy}>
        {busy ? <ActivityIndicator /> : <Text style={styles.label}>Photo</Text>}
      </Pressable>

      <Modal visible={busy} transparent animationType="fade">
        <View style={styles.backdrop}>
          <View style={styles.card}>
            <ActivityIndicator size="large" />
            <Text style={styles.caption}>Uploading…</Text>
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  label: { color: "#208AEF", fontSize: 16, fontWeight: "600" },
  backdrop: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.4)",
  },
  card: {
    backgroundColor: "#fff",
    borderRadius: 16,
    paddingVertical: 28,
    paddingHorizontal: 40,
    alignItems: "center",
    gap: 12,
  },
  caption: { fontSize: 15, fontWeight: "600", color: "#333" },
});
