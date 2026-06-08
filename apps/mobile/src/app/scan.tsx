import { useMutation, useQuery } from "@tanstack/react-query";
import { useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useCameraPermission } from "react-native-vision-camera";
import { CodeScanner } from "react-native-vision-camera-barcode-scanner";
import { useTRPC } from "@/lib/trpc";

const PRODUCT_FORMATS = [
  "ean-13",
  "ean-8",
  "upc-a",
  "upc-e",
  "code-128",
  "qr-code",
] as const;

const isValidUpc = (value: string) => /^\d{12,14}$/.test(value);

export default function ScanScreen() {
  const { hasPermission, requestPermission } = useCameraPermission();

  // Pause the camera when the tab isn't focused (expo-router's focus effect
  // avoids a phantom @react-navigation/native import under pnpm).
  const [isFocused, setIsFocused] = useState(false);
  useFocusEffect(
    useCallback(() => {
      setIsFocused(true);
      return () => setIsFocused(false);
    }, []),
  );

  const [scanned, setScanned] = useState<string | null>(null);
  // onBarcodeScanned fires ~30x/sec; lock so we only capture the first hit.
  const locked = useRef(false);

  const reset = useCallback(() => {
    locked.current = false;
    setScanned(null);
  }, []);

  if (!hasPermission) {
    return (
      <SafeAreaView style={styles.flex} edges={["top"]}>
        <View style={styles.center}>
          <Text style={styles.title}>Scan</Text>
          <Text style={styles.sub}>
            Camera access is needed to scan barcodes.
          </Text>
          <TouchableOpacity style={styles.button} onPress={requestPermission}>
            <Text style={styles.buttonText}>Grant camera access</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <View style={styles.flex}>
      <CodeScanner
        style={StyleSheet.absoluteFill}
        isActive={isFocused && !scanned}
        barcodeFormats={[...PRODUCT_FORMATS]}
        onBarcodeScanned={(barcodes) => {
          if (locked.current) return;
          const hit = barcodes.find(
            (b) => b.rawValue && isValidUpc(b.rawValue),
          );
          if (hit?.rawValue) {
            locked.current = true;
            setScanned(hit.rawValue);
          }
        }}
        onError={(e) => console.error("scanner error", e)}
      />

      {!scanned ? (
        <SafeAreaView
          style={styles.overlay}
          edges={["top"]}
          pointerEvents="none"
        >
          <Text style={styles.overlayText}>Point at a product barcode</Text>
          <View style={styles.reticle} />
        </SafeAreaView>
      ) : (
        <ScanResult upc={scanned} onScanAgain={reset} />
      )}
    </View>
  );
}

function ScanResult({
  upc,
  onScanAgain,
}: {
  upc: string;
  onScanAgain: () => void;
}) {
  const trpc = useTRPC();
  const lookup = useQuery(trpc.upc.lookup.queryOptions({ upc }));
  const add = useMutation(trpc.product.findOrCreateByUPC.mutationOptions());

  const product = lookup.data;

  return (
    <SafeAreaView style={styles.sheet} edges={["bottom"]}>
      <Text style={styles.upcLabel}>UPC {upc}</Text>

      {lookup.isLoading ? (
        <ActivityIndicator style={{ marginVertical: 16 }} />
      ) : product ? (
        <>
          <Text style={styles.name}>{product.name}</Text>
          {product.brand ? (
            <Text style={styles.sub}>{product.brand}</Text>
          ) : null}
        </>
      ) : (
        <Text style={styles.sub}>Unknown product — add it anyway?</Text>
      )}

      {add.isSuccess ? (
        <Text style={styles.success}>Added “{add.data.name}” to Cubby ✓</Text>
      ) : (
        <TouchableOpacity
          style={[styles.button, add.isPending && styles.buttonDisabled]}
          disabled={add.isPending}
          onPress={() =>
            add.mutate({ upc, defaultName: product?.name ?? undefined })
          }
        >
          <Text style={styles.buttonText}>
            {add.isPending ? "Adding…" : "Add to Cubby"}
          </Text>
        </TouchableOpacity>
      )}
      {add.error ? <Text style={styles.error}>{add.error.message}</Text> : null}

      <TouchableOpacity style={styles.secondary} onPress={onScanAgain}>
        <Text style={styles.secondaryText}>Scan again</Text>
      </TouchableOpacity>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: "#000" },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    backgroundColor: "#fff",
  },
  title: { fontSize: 28, fontWeight: "800" },
  overlay: { flex: 1, alignItems: "center", paddingTop: 24, gap: 24 },
  overlayText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
    textShadowColor: "rgba(0,0,0,0.6)",
    textShadowRadius: 4,
  },
  reticle: {
    width: 260,
    height: 160,
    borderWidth: 3,
    borderColor: "rgba(255,255,255,0.9)",
    borderRadius: 16,
    marginTop: 80,
  },
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "#fff",
    padding: 20,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    gap: 8,
  },
  upcLabel: { fontSize: 13, color: "#999", fontVariant: ["tabular-nums"] },
  name: { fontSize: 20, fontWeight: "700" },
  sub: { fontSize: 15, color: "#666" },
  success: { fontSize: 16, fontWeight: "600", color: "#1a7f37", marginTop: 8 },
  error: { color: "#c0392b" },
  button: {
    backgroundColor: "#208AEF",
    borderRadius: 10,
    padding: 14,
    alignItems: "center",
    marginTop: 8,
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  secondary: { padding: 12, alignItems: "center" },
  secondaryText: { color: "#208AEF", fontSize: 15, fontWeight: "600" },
});
