import AppKit
import CoreGraphics
import CubbyKit
import Foundation

enum MacBrowserPermissionStatus: Equatable {
    case unknown
    case granted
    case denied

    var label: String {
        switch self {
        case .unknown: "Requested when first used"
        case .granted: "Allowed"
        case .denied: "Open System Settings"
        }
    }
}

struct MacBrowserPermissionSnapshot: Equatable {
    let appleEvents: MacBrowserPermissionStatus
    let screenRecording: MacBrowserPermissionStatus

    static func current(browser: BrowserChoice) -> Self {
        Self(
            appleEvents: appleEventsStatus(browser: browser),
            screenRecording: CGPreflightScreenCaptureAccess() ? .granted : .denied)
    }

    private static func appleEventsStatus(browser: BrowserChoice) -> MacBrowserPermissionStatus {
        let bundleIdentifier = browser == .safari ? "com.apple.Safari" : "com.google.Chrome"
        let target = NSAppleEventDescriptor(bundleIdentifier: bundleIdentifier)
        let status = AEDeterminePermissionToAutomateTarget(
            target.aeDesc, typeWildCard, typeWildCard, false)
        switch status {
        case noErr: return .granted
        case OSStatus(errAEEventNotPermitted): return .denied
        default: return .unknown
        }
    }

    static func requestScreenRecording() -> Bool {
        CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess()
    }

    static func openSettings(_ pane: Pane) {
        let anchor: String
        switch pane {
        case .automation: anchor = "Privacy_Automation"
        case .screenRecording: anchor = "Privacy_ScreenCapture"
        }
        guard
            let url = URL(
                string: "x-apple.systempreferences:com.apple.preference.security?\(anchor)")
        else { return }
        NSWorkspace.shared.open(url)
    }

    enum Pane { case automation, screenRecording }
}
