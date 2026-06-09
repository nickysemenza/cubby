import { unsafeProductId } from "@cubby/schemas/identifiers";
import { getErrorMessage } from "@cubby/shared";
import { useQueryClient } from "@tanstack/react-query";
import * as ImagePicker from "expo-image-picker";
import { useState } from "react";
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Text,
} from "react-native";
import { useTRPC, useTRPCClient } from "@/lib/trpc";
import { uploadAndAttachToProduct } from "@/lib/upload-image";

/** Nav-bar action: take/pick a photo, upload to R2, attach to the product. */
export function AddPhotoButton({ productId }: { productId: string }) {
  const client = useTRPCClient();
  const trpc = useTRPC();
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
      await Promise.all([
        qc.invalidateQueries({
          queryKey: trpc.product.getByID.queryKey({
            id: unsafeProductId(productId),
          }),
        }),
        qc.invalidateQueries({ queryKey: ["product", "list"] }),
        qc.invalidateQueries({ queryKey: ["inventory", "list"] }),
      ]);
    } catch (e) {
      Alert.alert("Upload failed", getErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const onPress = () => {
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

  if (busy) return <ActivityIndicator style={styles.spinner} />;

  return (
    <Pressable onPress={onPress} hitSlop={8}>
      <Text style={styles.label}>Photo</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  label: { color: "#208AEF", fontSize: 16, fontWeight: "600" },
  spinner: { marginRight: 4 },
});
