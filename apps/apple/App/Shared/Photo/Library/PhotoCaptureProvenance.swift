import CoreLocation
import Foundation
import MapKit
import Observation

/// A photo's reverse-geocoded locality plus the time zone that placemark reported, for the
/// capture-date provenance caption (A2, Q15c). `timeZone` is nil exactly when `city` is (no
/// location, or the lookup failed) — the caption then falls back to the device's zone.
struct PhotoProvenanceLocality: Sendable, Equatable {
    let city: String?
    let timeZone: TimeZone?
}

/// Reverse-geocodes a photo's `CLLocation` for the capture-date provenance caption: "Set from the
/// photo · taken 10:33 AM in San Francisco". One request per photo id, at most one in flight at a
/// time; both a resolved city and a failure/no-location are cached so a bad lookup is never
/// retried on every render.
@MainActor
@Observable
final class PhotoCaptureProvenance {
    private var cache: [String: PhotoProvenanceLocality] = [:]
    private var inFlight: Set<String> = []
    /// The cached result for `id`, or nil while a lookup hasn't run (or finished) yet.
    func result(for id: String) -> PhotoProvenanceLocality? {
        cache[id]
    }

    /// Starts (or joins) the reverse geocode for `location` keyed by `id`. Fire-and-forget from a
    /// view's `.task(id:)` — SwiftUI cancels the previous task as the focused photo changes, and
    /// `inFlight` covers a second concurrent call for the same id.
    func resolve(id: String, location: CLLocation?) async {
        guard cache[id] == nil, !inFlight.contains(id) else { return }
        guard let location else {
            cache[id] = PhotoProvenanceLocality(city: nil, timeZone: nil)
            return
        }
        inFlight.insert(id)
        defer { inFlight.remove(id) }
        do {
            guard let request = MKReverseGeocodingRequest(location: location) else {
                cache[id] = PhotoProvenanceLocality(city: nil, timeZone: nil)
                return
            }
            let mapItem = try await request.mapItems.first
            cache[id] = PhotoProvenanceLocality(
                city: mapItem?.addressRepresentations?.cityName,
                timeZone: mapItem?.timeZone)
        } catch is CancellationError {
            // A SwiftUI `.task(id:)` cancellation is not a failed lookup; leave it retryable.
            return
        } catch {
            Diagnostics.report(error, context: "photos.provenance.reverseGeocode")
            cache[id] = PhotoProvenanceLocality(city: nil, timeZone: nil)
        }
    }

    /// "Set from the photo · taken 10:33 AM[ in San Francisco]" — pure so a test can cover both
    /// forms without touching `CLGeocoder`, and `nonisolated` since it needs no `@MainActor`
    /// state. `timeZone` is the photo's own (from its placemark) when known, else the device's;
    /// the " in …" clause drops entirely without a city.
    nonisolated static func caption(capturedAt: Date, timeZone: TimeZone?, city: String?) -> String {
        let formatter = DateFormatter()
        formatter.dateStyle = .none
        formatter.timeStyle = .short
        formatter.timeZone = timeZone ?? .current
        let time = formatter.string(from: capturedAt)
        guard let city, !city.isEmpty else { return "Set from the photo · taken \(time)" }
        return "Set from the photo · taken \(time) in \(city)"
    }
}
