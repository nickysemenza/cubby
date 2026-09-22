import CubbyKit
import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var model
    @State private var appliedStashedLaunchLink = false
    @AppStorage("developerOverlays") private var developerOverlays = false

    var body: some View {
        content
            // Set once, at the root, from storage: every descendant reads it via
            // `@Environment(\.developerOverlays)` instead of its own `@AppStorage`, so toggling in
            // `DevView` updates every open screen at once.
            .environment(\.developerOverlays, developerOverlays)
    }

    @ViewBuilder
    private var content: some View {
        switch model.phase {
        case .restoring:
            VStack(spacing: PorcelainTokens.Space.md) {
                LoadingIndicator(label: "Checking sign-in")
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(PorcelainTokens.canvas)
        case .signedOut:
            LoginView()
        case .signedIn:
            Group {
                #if os(iOS)
                    RootTabsView()
                #else
                    RootSplitView()
                #endif
            }
            .id(ObjectIdentifier(model.client))
            .task(id: model.host) {
                await model.spotlight.refreshIfNeeded(client: model.client, host: model.host)
            }
            #if os(iOS)
                .task { applyStashedLaunchLinkIfNeeded() }
            #endif
            // Layer 6: a one-line monospaced strip for the last request `CubbyAuthMiddleware`
            // observed, only while the toggle is on — an overlay/caption only, never affecting the
            // rest of the layout (`DESIGN.md` § Developer overlays).
            .safeAreaInset(edge: .bottom) {
                if developerOverlays, let last = model.requestTrace.last {
                    RequestTraceStrip(entry: last)
                }
            }
            // Asked once per install, right after sign-in: until it is answered the participation
            // master switch stays off (`DeviceParticipation`'s default).
            .sheet(isPresented: showsParticipationOnboarding) {
                DeviceParticipationOnboardingSheet()
            }
        }
    }

    private var showsParticipationOnboarding: Binding<Bool> {
        Binding(
            get: { model.participation.answeredAt == nil },
            set: { presented in
                // Any dismissal path (including the sheet's own buttons, which already call
                // `setParticipation`) must leave `answeredAt` set so this never reappears.
                guard !presented, model.participation.answeredAt == nil else { return }
                model.setParticipation(automaticWork: model.participation.automaticWork)
            })
    }

    #if os(iOS)
        /// Belt-and-suspenders for `AppDelegate`'s cold-launch Quick Action handling: in the
        /// ordinary case `AppModel.active` already exists by `willConnectTo` and the link is
        /// applied there directly, so this finds nothing. It only matters if that invariant is
        /// ever wrong — then the link is stashed instead of dropped, and this applies it once,
        /// the first time the signed-in shell appears.
        private func applyStashedLaunchLinkIfNeeded() {
            guard !appliedStashedLaunchLink, let link = AppDelegate.takeStashedLaunchLink() else { return }
            appliedStashedLaunchLink = true
            model.navigator.open(link)
        }
    #endif
}

#Preview("Signed out", traits: .modifier(SignedOutPreview())) {
    RootView()
}

#Preview("Signed in", traits: .modifier(SignedInPreview())) {
    RootView()
}
