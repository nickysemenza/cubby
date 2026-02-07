import { CameraView, useCameraPermissions } from "expo-camera";
import { useRouter } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";

import { trpcClient } from "@/lib/api";
import {
  colors,
  extractShortcodeFromScan,
  getErrorMessage,
} from "@cubby/shared";

const COOLDOWN_MS = 2000;

export default function ScanScreen() {
  const router = useRouter();
  const [permission, requestPermission] = useCameraPermissions();
  const [scanned, setScanned] = useState(false);
  const lastScanTime = useRef(0);

  const handleBarCodeScanned = useCallback(
    async ({ data }: { data: string }) => {
      const now = Date.now();
      if (scanned || now - lastScanTime.current < COOLDOWN_MS) return;

      setScanned(true);
      lastScanTime.current = now;

      try {
        const shortcode = extractShortcodeFromScan(data);
        if (shortcode) {
          if (shortcode.type === "product") {
            const product = await trpcClient.product.getByShortcode.query({
              shortcode: shortcode.shortcode,
            });
            router.push(`/product/${product.id}`);
          } else if (shortcode.type === "location") {
            const location = await trpcClient.location.getByShortcode.query({
              shortcode: shortcode.shortcode,
            });
            router.push(`/location/${location.id}`);
          } else if (shortcode.type === "recipe") {
            Alert.alert("Recipe", `Found recipe: ${shortcode.shortcode}`);
          }
          return;
        }

        const upc = data.replace(/^0+/, "");
        if (upc.length >= 8 && upc.length <= 14) {
          const product = await trpcClient.product.findOrCreateByUPC.mutate({
            upc,
          });
          router.push(`/product/${product.id}`);
          return;
        }

        Alert.alert("Unknown", `Scanned: ${data}`);
      } catch (e) {
        Alert.alert("Error", getErrorMessage(e));
      } finally {
        setTimeout(() => setScanned(false), COOLDOWN_MS);
      }
    },
    [scanned, router],
  );

  if (!permission) {
    return <View style={styles.cameraContainer} />;
  }

  if (!permission.granted) {
    return (
      <View style={styles.center}>
        <Text style={styles.permissionText}>
          Camera permission is needed to scan barcodes and QR codes.
        </Text>
        <Pressable style={styles.button} onPress={requestPermission}>
          <Text style={styles.buttonText}>Grant Permission</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.cameraContainer}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{
          barcodeTypes: ["qr", "ean13", "ean8", "upc_a", "upc_e"],
        }}
        onBarcodeScanned={scanned ? undefined : handleBarCodeScanned}
      />
      {scanned && (
        <View style={styles.overlay}>
          <Pressable
            style={styles.scanAgainButton}
            onPress={() => setScanned(false)}
          >
            <Text style={styles.scanAgainText}>Tap to Scan Again</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  cameraContainer: { flex: 1, backgroundColor: "#000" },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.cream,
    paddingHorizontal: 32,
  },
  permissionText: {
    fontSize: 16,
    textAlign: "center",
    marginBottom: 16,
    color: colors.foreground,
  },
  button: {
    backgroundColor: colors.terracotta,
    borderRadius: 8,
    paddingHorizontal: 24,
    paddingVertical: 12,
  },
  buttonText: { color: colors.cream, fontWeight: "600" },
  overlay: {
    position: "absolute",
    bottom: 32,
    left: 0,
    right: 0,
    alignItems: "center",
  },
  scanAgainButton: {
    backgroundColor: colors.cream,
    borderRadius: 8,
    paddingHorizontal: 24,
    paddingVertical: 12,
  },
  scanAgainText: { fontWeight: "600", color: colors.foreground },
});
