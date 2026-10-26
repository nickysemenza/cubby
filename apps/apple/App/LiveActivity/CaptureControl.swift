import SwiftUI
import WidgetKit

struct CaptureControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "com.nickysemenza.cubby.capture") {
            ControlWidgetButton(action: OpenCaptureControlIntent()) {
                Label("Capture", systemImage: "viewfinder")
            }
        }
        .displayName("Capture")
        .description("Open the scanner and photo import tools.")
    }
}
