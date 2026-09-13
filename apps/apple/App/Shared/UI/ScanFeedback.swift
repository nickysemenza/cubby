import CubbyKit
import SwiftUI

#if os(iOS)
    import AudioToolbox
#endif

/// A scan chip's status (`ScanSession.ChipStatus` — shared by `ScanSession` and
/// `RecountSession`, which reuses the same type) reduced to the three feedback buckets
/// `BinView`/`CaptureView` drive haptics and sound from.
public enum ScanFeedbackKind: Sendable, Hashable {
    case success, warning, error
}

extension ScanFeedbackKind {
    /// `.added`/`.confirmed` count the row as-is → success. `.queued` (found in another bin;
    /// needs a decision before the walk can finish) → warning. `.failed` (the scanner or
    /// manual-entry field rejected the value outright) → error. `.pending` (submitted, still
    /// awaiting the server) has no feedback yet — it isn't a resolved outcome.
    public init?(chipStatus: ScanSession.ChipStatus) {
        switch chipStatus {
        case .added, .confirmed: self = .success
        case .queued: self = .warning
        case .failed: self = .error
        case .pending: return nil
        }
    }
}

extension View {
    /// Fires a distinct haptic — and, on iOS, a distinct short system sound for success vs.
    /// warning — whenever `trigger` changes and `kind` is non-nil at that instant. Pass an
    /// `Equatable` value that changes once per scan outcome (e.g. the session's chip list, which
    /// changes both when a new chip is pushed and when an existing one's status settles) so a
    /// status that never resolves (`.pending`) produces no feedback.
    func scanFeedback(_ kind: ScanFeedbackKind?, trigger: some Equatable) -> some View {
        self
            .sensoryFeedback(trigger: trigger) { _, _ in
                switch kind {
                case .success: .success
                case .warning: .warning
                case .error: .error
                case nil: nil
                }
            }
            #if os(iOS)
                .onChange(of: trigger) { _, _ in
                    switch kind {
                    // 1057 "Tink" and 1053 "SIMToolkitNegativeACK" are both real, short, and
                    // audibly distinct system sound effect IDs. `.error` plays no extra sound —
                    // a rejected scan is already narrated by the chip's error text and color, and
                    // three overlapping tones during a fast walk is noise, not signal.
                    case .success: AudioServicesPlaySystemSound(1057)
                    case .warning: AudioServicesPlaySystemSound(1053)
                    case .error, nil: break
                    }
                }
            #endif
    }
}
