import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useQuery } from "@tanstack/react-query";
import {
  type LocationType,
  colors,
  extractShortcodeFromScan,
  getErrorMessage,
  withOpacity,
} from "@cubby/shared";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

import { LocationTypeBadge } from "@/components/LocationTypeBadge";
import { api, trpcClient } from "@/lib/api";

type TreeLocation = {
  id: string;
  name: string;
  type: string;
  shortcode: string;
  children?: TreeLocation[];
};

type ScanResult = {
  id: string;
  name: string;
  type: string;
  shortcode: string;
  status: "confirmed" | "unexpected";
};

type Phase = "select" | "scanning" | "reconcile";

const COOLDOWN_MS = 1500;

export default function ValidateLocationScreen() {
  const router = useRouter();
  const { parentId } = useLocalSearchParams<{ parentId?: string }>();
  const [permission, requestPermission] = useCameraPermissions();

  const [phase, setPhase] = useState<Phase>("select");
  const [selectedParent, setSelectedParent] = useState<TreeLocation | null>(
    null,
  );
  const [scannedItems, setScannedItems] = useState<ScanResult[]>([]);
  const [scannedIds, setScannedIds] = useState<Set<string>>(new Set());
  const lastScanTime = useRef(0);

  const { data: tree, isLoading } = useQuery(
    api.location.makeTree.queryOptions(),
  );

  // Find parent locations (those with children)
  const findParentLocations = useCallback((): TreeLocation[] => {
    if (!tree) return [];
    const parents: TreeLocation[] = [];

    function walk(nodes: TreeLocation[]) {
      for (const node of nodes) {
        if (node.children && node.children.length > 0) {
          parents.push(node);
          walk(node.children);
        }
      }
    }

    walk(tree as TreeLocation[]);
    return parents;
  }, [tree]);

  // Find a specific location in the tree by ID
  const findLocationById = useCallback(
    (targetId: string): TreeLocation | null => {
      if (!tree) return null;

      function walk(nodes: TreeLocation[]): TreeLocation | null {
        for (const node of nodes) {
          if (node.id === targetId) return node;
          if (node.children) {
            const found = walk(node.children);
            if (found) return found;
          }
        }
        return null;
      }

      return walk(tree as TreeLocation[]);
    },
    [tree],
  );

  // Auto-select parent from URL param
  if (parentId && !selectedParent && tree) {
    const found = findLocationById(parentId);
    if (found) {
      setSelectedParent(found);
    }
  }

  const expectedChildren = selectedParent?.children ?? [];

  const handleBarCodeScanned = useCallback(
    async ({ data }: { data: string }) => {
      const now = Date.now();
      if (now - lastScanTime.current < COOLDOWN_MS) return;
      lastScanTime.current = now;

      try {
        const shortcode = extractShortcodeFromScan(data);
        if (!shortcode || shortcode.type !== "location") {
          Alert.alert(
            "Not a location",
            "This QR code is not a location shortcode.",
          );
          return;
        }

        const location = await trpcClient.location.getByShortcode.query({
          shortcode: shortcode.shortcode,
        });

        if (!location) {
          Alert.alert(
            "Not found",
            `No location found for ${shortcode.shortcode}`,
          );
          return;
        }

        if (scannedIds.has(location.id)) return; // Already scanned

        const isExpected = expectedChildren.some((c) => c.id === location.id);

        setScannedIds((prev) => new Set(prev).add(location.id));
        setScannedItems((prev) => [
          ...prev,
          {
            id: location.id,
            name: location.name,
            type: location.type,
            shortcode: location.shortcode,
            status: isExpected ? "confirmed" : "unexpected",
          },
        ]);
      } catch (e) {
        Alert.alert("Error", getErrorMessage(e));
      }
    },
    [expectedChildren, scannedIds],
  );

  const startScanning = () => {
    setScannedItems([]);
    setScannedIds(new Set());
    setPhase("scanning");
  };

  const handleReassign = async (locationId: string) => {
    if (!selectedParent) return;
    try {
      await trpcClient.location.update.mutate({
        id: locationId,
        data: { parentId: selectedParent.id },
      });
      // Move from unexpected to confirmed
      setScannedItems((prev) =>
        prev.map((item) =>
          item.id === locationId ? { ...item, status: "confirmed" } : item,
        ),
      );
      Alert.alert("Moved", "Location has been reassigned to this parent.");
    } catch (e) {
      Alert.alert("Error", getErrorMessage(e));
    }
  };

  const startOver = () => {
    setSelectedParent(null);
    setScannedItems([]);
    setScannedIds(new Set());
    setPhase("select");
  };

  // PHASE 1: Select Parent Location
  if (phase === "select") {
    if (isLoading) {
      return (
        <View style={styles.center}>
          <Stack.Screen options={{ title: "Validate Location" }} />
          <ActivityIndicator size="large" color={colors.terracotta} />
        </View>
      );
    }

    if (selectedParent) {
      return (
        <View style={styles.container}>
          <Stack.Screen
            options={{ title: `Validate: ${selectedParent.name}` }}
          />
          <View style={styles.selectedHeader}>
            <Text style={styles.selectedName}>{selectedParent.name}</Text>
            <LocationTypeBadge type={selectedParent.type as LocationType} />
          </View>

          <Text style={styles.sectionTitle}>
            Expected children ({expectedChildren.length})
          </Text>
          <FlatList
            data={expectedChildren}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => (
              <View style={styles.childRow}>
                <Text style={styles.childName}>{item.name}</Text>
                <LocationTypeBadge type={item.type as LocationType} />
                <Text style={styles.childShortcode}>{item.shortcode}</Text>
              </View>
            )}
          />

          <View style={styles.actionBar}>
            <TouchableOpacity
              style={styles.secondaryActionButton}
              onPress={() => setSelectedParent(null)}
            >
              <Text style={styles.secondaryActionText}>Change</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.primaryButton}
              onPress={startScanning}
            >
              <MaterialIcons
                name="qr-code-scanner"
                size={20}
                color={colors.cream}
              />
              <Text style={styles.primaryButtonText}>Start Scanning</Text>
            </TouchableOpacity>
          </View>
        </View>
      );
    }

    const parentLocations = findParentLocations();

    return (
      <View style={styles.container}>
        <Stack.Screen options={{ title: "Validate Location" }} />
        <Text style={styles.sectionTitle}>Select a parent location</Text>
        <FlatList
          data={parentLocations}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={styles.parentRow}
              onPress={() => setSelectedParent(item)}
            >
              <View style={styles.parentInfo}>
                <Text style={styles.parentName}>{item.name}</Text>
                <LocationTypeBadge type={item.type as LocationType} />
              </View>
              <Text style={styles.parentChildCount}>
                {item.children?.length ?? 0} children
              </Text>
            </TouchableOpacity>
          )}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyText}>No parent locations found</Text>
            </View>
          }
        />
      </View>
    );
  }

  // PHASE 2: Scanning
  if (phase === "scanning") {
    if (!permission?.granted) {
      return (
        <View style={styles.center}>
          <Stack.Screen options={{ title: "Scanning" }} />
          <Text style={styles.permissionText}>
            Camera permission is needed to scan QR codes.
          </Text>
          <Pressable style={styles.primaryButton} onPress={requestPermission}>
            <Text style={styles.primaryButtonText}>Grant Permission</Text>
          </Pressable>
        </View>
      );
    }

    const confirmedCount = scannedItems.filter(
      (i) => i.status === "confirmed",
    ).length;
    const unexpectedCount = scannedItems.filter(
      (i) => i.status === "unexpected",
    ).length;

    return (
      <View style={styles.scanContainer}>
        <Stack.Screen options={{ title: "Scanning" }} />
        <CameraView
          style={styles.camera}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          onBarcodeScanned={handleBarCodeScanned}
        />
        {/* Checklist overlay */}
        <View style={styles.scanOverlay}>
          <ScrollView style={styles.checklist}>
            <Text style={styles.checklistTitle}>
              {confirmedCount}/{expectedChildren.length} confirmed
              {unexpectedCount > 0 ? ` · ${unexpectedCount} unexpected` : ""}
            </Text>
            {expectedChildren.map((child) => {
              const isScanned = scannedIds.has(child.id);
              return (
                <View key={child.id} style={styles.checkItem}>
                  <MaterialIcons
                    name={isScanned ? "check-circle" : "radio-button-unchecked"}
                    size={20}
                    color={
                      isScanned ? "hsl(140, 50%, 42%)" : colors.mutedForeground
                    }
                  />
                  <Text
                    style={[
                      styles.checkItemText,
                      isScanned && styles.checkItemScanned,
                    ]}
                  >
                    {child.name}
                  </Text>
                </View>
              );
            })}
            {scannedItems
              .filter((i) => i.status === "unexpected")
              .map((item) => (
                <View key={item.id} style={styles.checkItem}>
                  <MaterialIcons
                    name="help"
                    size={20}
                    color="hsl(210, 60%, 50%)"
                  />
                  <Text style={styles.checkItemUnexpected}>{item.name}</Text>
                </View>
              ))}
          </ScrollView>
          <TouchableOpacity
            style={styles.doneButton}
            onPress={() => setPhase("reconcile")}
          >
            <Text style={styles.doneButtonText}>Done Scanning</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // PHASE 3: Reconciliation
  const confirmed = scannedItems.filter((i) => i.status === "confirmed");
  const unexpected = scannedItems.filter((i) => i.status === "unexpected");
  const missing = expectedChildren.filter((c) => !scannedIds.has(c.id));

  return (
    <ScrollView style={styles.container}>
      <Stack.Screen options={{ title: "Validation Results" }} />

      {/* Confirmed */}
      {confirmed.length > 0 && (
        <View style={styles.resultSection}>
          <View
            style={[
              styles.resultHeader,
              { backgroundColor: withOpacity("hsl(140, 50%, 42%)", 0.1) },
            ]}
          >
            <MaterialIcons
              name="check-circle"
              size={20}
              color="hsl(140, 50%, 42%)"
            />
            <Text
              style={[styles.resultHeaderText, { color: "hsl(140, 50%, 42%)" }]}
            >
              Confirmed ({confirmed.length})
            </Text>
          </View>
          {confirmed.map((item) => (
            <View key={item.id} style={styles.resultRow}>
              <Text style={styles.resultName}>{item.name}</Text>
              <LocationTypeBadge type={item.type as LocationType} />
            </View>
          ))}
        </View>
      )}

      {/* Missing */}
      {missing.length > 0 && (
        <View style={styles.resultSection}>
          <View
            style={[
              styles.resultHeader,
              { backgroundColor: "hsl(35, 80%, 95%)" },
            ]}
          >
            <MaterialIcons name="warning" size={20} color="hsl(35, 80%, 50%)" />
            <Text
              style={[styles.resultHeaderText, { color: "hsl(35, 80%, 40%)" }]}
            >
              Missing ({missing.length})
            </Text>
          </View>
          {missing.map((item) => (
            <View key={item.id} style={styles.resultRow}>
              <View style={styles.resultInfo}>
                <Text style={styles.resultName}>{item.name}</Text>
                <LocationTypeBadge type={item.type as LocationType} />
              </View>
              <Text style={styles.resultSubtext}>Not scanned</Text>
            </View>
          ))}
        </View>
      )}

      {/* Unexpected */}
      {unexpected.length > 0 && (
        <View style={styles.resultSection}>
          <View
            style={[
              styles.resultHeader,
              { backgroundColor: withOpacity("hsl(210, 60%, 50%)", 0.1) },
            ]}
          >
            <MaterialIcons name="help" size={20} color="hsl(210, 60%, 50%)" />
            <Text
              style={[styles.resultHeaderText, { color: "hsl(210, 60%, 50%)" }]}
            >
              Unexpected ({unexpected.length})
            </Text>
          </View>
          {unexpected.map((item) => (
            <View key={item.id} style={styles.resultRow}>
              <View style={styles.resultInfo}>
                <Text style={styles.resultName}>{item.name}</Text>
                <LocationTypeBadge type={item.type as LocationType} />
              </View>
              <TouchableOpacity
                style={styles.reassignButton}
                onPress={() => handleReassign(item.id)}
              >
                <Text style={styles.reassignText}>Confirm Here</Text>
              </TouchableOpacity>
            </View>
          ))}
        </View>
      )}

      <View style={styles.bottomActions}>
        <TouchableOpacity
          style={styles.secondaryActionButton}
          onPress={startOver}
        >
          <Text style={styles.secondaryActionText}>Start Over</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.primaryButton}
          onPress={() => router.back()}
        >
          <Text style={styles.primaryButtonText}>Done</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.cream },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.cream,
    paddingHorizontal: 32,
  },
  // Phase 1 styles
  selectedHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  selectedName: { fontSize: 18, fontWeight: "600", color: colors.foreground },
  sectionTitle: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.shelf,
    paddingHorizontal: 16,
    paddingVertical: 10,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  childRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  childName: { flex: 1, fontSize: 15, color: colors.foreground },
  childShortcode: {
    fontSize: 13,
    color: colors.mutedForeground,
    fontFamily: "monospace",
  },
  parentRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  parentInfo: { flexDirection: "row", alignItems: "center", gap: 8 },
  parentName: { fontSize: 16, fontWeight: "500", color: colors.foreground },
  parentChildCount: { fontSize: 13, color: colors.mutedForeground },
  actionBar: {
    flexDirection: "row",
    gap: 12,
    padding: 16,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  // Phase 2 styles
  scanContainer: { flex: 1 },
  camera: { flex: 1 },
  scanOverlay: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    maxHeight: "50%",
    backgroundColor: "rgba(255,255,255,0.95)",
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 16,
  },
  checklist: { maxHeight: 200 },
  checklistTitle: {
    fontSize: 15,
    fontWeight: "600",
    color: colors.foreground,
    marginBottom: 8,
  },
  checkItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 4,
  },
  checkItemText: { fontSize: 14, color: colors.foreground },
  checkItemScanned: { color: "hsl(140, 50%, 42%)", fontWeight: "500" },
  checkItemUnexpected: { fontSize: 14, color: "hsl(210, 60%, 50%)" },
  doneButton: {
    backgroundColor: colors.terracotta,
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: "center",
    marginTop: 12,
  },
  doneButtonText: { color: colors.cream, fontWeight: "600", fontSize: 15 },
  permissionText: {
    fontSize: 16,
    textAlign: "center",
    marginBottom: 16,
    color: colors.foreground,
  },
  // Phase 3 styles
  resultSection: { marginBottom: 16 },
  resultHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  resultHeaderText: { fontSize: 14, fontWeight: "600" },
  resultRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  resultInfo: { flexDirection: "row", alignItems: "center", gap: 8, flex: 1 },
  resultName: { fontSize: 15, color: colors.foreground },
  resultSubtext: { fontSize: 13, color: colors.mutedForeground },
  reassignButton: {
    backgroundColor: withOpacity("hsl(210, 60%, 50%)", 0.12),
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  reassignText: {
    fontSize: 13,
    fontWeight: "600",
    color: "hsl(210, 60%, 50%)",
  },
  bottomActions: {
    flexDirection: "row",
    gap: 12,
    padding: 16,
  },
  // Shared buttons
  primaryButton: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: colors.terracotta,
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  primaryButtonText: { color: colors.cream, fontWeight: "600", fontSize: 15 },
  secondaryActionButton: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: colors.terracotta,
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  secondaryActionText: {
    color: colors.terracotta,
    fontWeight: "600",
    fontSize: 15,
  },
  empty: { alignItems: "center", paddingVertical: 32 },
  emptyText: { color: colors.mutedForeground },
});
