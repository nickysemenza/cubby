import CubbyKit
import SwiftUI

/// Shared entry point for Settings and the Activity route's toolbar.
struct ProcessImageQueueButton: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        #if os(iOS)
            if #available(iOS 26.0, *) {
                Button("Process queue now", systemImage: "play.fill") {
                    ImageQueueBackgroundProcessing.shared.processNow(model: model)
                }
                .disabled(
                    !model.participation.automaticWork || model.requestTrace.clientUpdateRequired
                        || ImageQueueBackgroundProcessing.shared.isRunning
                )
                .accessibilityIdentifier("images.processQueueNow")
            }
        #endif
    }
}

#Preview(traits: .modifier(SignedInPreview())) {
    ProcessImageQueueButton()
}

extension View {
    /// Applied at the route composition boundary, keeping Activity's queue rendering independent.
    func imageQueueProcessingToolbar() -> some View {
        toolbar {
            #if os(iOS)
                ToolbarItem(placement: .primaryAction) { ProcessImageQueueButton() }
            #endif
        }
    }
}
