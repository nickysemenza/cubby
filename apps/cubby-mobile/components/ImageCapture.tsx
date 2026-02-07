import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { colors, getErrorMessage } from "@cubby/shared";
import * as ImagePicker from "expo-image-picker";
import { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

import { trpcClient } from "@/lib/api";

type EntityType = "PRODUCT" | "LOCATION" | "RECIPE";

type Props = {
  entityType: EntityType;
  onImageUploaded: (imageId: string) => void;
};

export function ImageCapture({ entityType, onImageUploaded }: Props) {
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);

  async function uploadImage(result: ImagePicker.ImagePickerResult) {
    if (result.canceled || !result.assets[0]) return;

    const asset = result.assets[0];
    setPreview(asset.uri);
    setUploading(true);

    try {
      const filename = asset.fileName ?? `photo_${Date.now()}.jpg`;
      const contentType = asset.mimeType ?? "image/jpeg";
      const size = asset.fileSize ?? 0;

      // Step 1: Get presigned upload URL
      const { uploadUrl, imageId } = await trpcClient.image.uploadImage.mutate({
        filename,
        contentType,
        size,
        entityType,
      });

      // Step 2: Upload file to S3
      const response = await fetch(asset.uri);
      const blob = await response.blob();
      await fetch(uploadUrl, {
        method: "PUT",
        body: blob,
        headers: { "Content-Type": contentType },
      });

      onImageUploaded(imageId);
    } catch (e) {
      Alert.alert("Upload failed", getErrorMessage(e));
      setPreview(null);
    } finally {
      setUploading(false);
    }
  }

  async function takePhoto() {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      Alert.alert(
        "Permission needed",
        "Camera access is required to take photos.",
      );
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      quality: 0.8,
      allowsEditing: true,
    });
    await uploadImage(result);
  }

  async function pickFromLibrary() {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert("Permission needed", "Photo library access is required.");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      quality: 0.8,
      allowsEditing: true,
    });
    await uploadImage(result);
  }

  return (
    <View style={styles.container}>
      {preview && (
        <View style={styles.previewContainer}>
          <Image source={{ uri: preview }} style={styles.preview} />
          {uploading && (
            <View style={styles.uploadOverlay}>
              <ActivityIndicator size="small" color="#fff" />
              <Text style={styles.uploadText}>Uploading...</Text>
            </View>
          )}
        </View>
      )}
      <View style={styles.buttons}>
        <TouchableOpacity
          style={styles.button}
          onPress={takePhoto}
          disabled={uploading}
        >
          <MaterialIcons name="camera-alt" size={20} color={colors.cream} />
          <Text style={styles.buttonText}>Take Photo</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.button, styles.secondaryButton]}
          onPress={pickFromLibrary}
          disabled={uploading}
        >
          <MaterialIcons
            name="photo-library"
            size={20}
            color={colors.terracotta}
          />
          <Text style={[styles.buttonText, styles.secondaryText]}>Library</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { marginTop: 16 },
  previewContainer: {
    marginBottom: 12,
    borderRadius: 8,
    overflow: "hidden",
  },
  preview: {
    width: "100%",
    height: 200,
    borderRadius: 8,
    backgroundColor: colors.muted,
  },
  uploadOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.5)",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  uploadText: { color: "#fff", fontWeight: "600" },
  buttons: { flexDirection: "row", gap: 12 },
  button: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    backgroundColor: colors.terracotta,
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  secondaryButton: {
    backgroundColor: "transparent",
    borderWidth: 1,
    borderColor: colors.terracotta,
  },
  buttonText: { color: colors.cream, fontWeight: "600", fontSize: 14 },
  secondaryText: { color: colors.terracotta },
});
