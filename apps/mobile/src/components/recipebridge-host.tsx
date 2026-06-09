import { useRef } from "react";
import { StyleSheet, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { RECIPEBRIDGE_HOST_HTML } from "@/lib/recipebridge-host.generated";
import { handleHostMessage, setHostPoster } from "@/lib/recipebridge";

// Mount ONCE at app root. Renders an off-screen WebView that instantiates the
// recipebridge WASM and answers calls over postMessage (see lib/recipebridge.ts).
export function RecipebridgeHost() {
  const ref = useRef<WebView>(null);
  setHostPoster((s) => ref.current?.postMessage(s));

  return (
    <View style={styles.hidden} pointerEvents="none">
      <WebView
        ref={ref}
        source={{ html: RECIPEBRIDGE_HOST_HTML }}
        originWhitelist={["*"]}
        javaScriptEnabled
        onMessage={(e: WebViewMessageEvent) =>
          handleHostMessage(e.nativeEvent.data)
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  hidden: { position: "absolute", width: 0, height: 0, opacity: 0 },
});
