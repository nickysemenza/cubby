import { StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

export default function ScanScreen() {
  return (
    <SafeAreaView style={styles.flex} edges={["top"]}>
      <View style={styles.center}>
        <Text style={styles.title}>Scan</Text>
        <Text style={styles.sub}>Barcode scanner coming up.</Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: "#fff" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 8 },
  title: { fontSize: 28, fontWeight: "800" },
  sub: { fontSize: 15, color: "#666" },
});
