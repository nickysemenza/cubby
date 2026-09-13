import Foundation

/// The label the camera floats over a recognized barcode while a bin is being walked or stocked.
/// Computed locally from what the session already knows — never a request per frame — so an
/// unknown barcode stays unlabelled until a scan resolves it.
public struct ShelfAnnotation: Sendable, Hashable {
    public enum Tone: Sendable, Hashable {
        /// Expected here and not yet looked at.
        case expected
        /// Verified, adjusted, or stocked in this walk.
        case verified
        /// Not expected in this bin.
        case unexpected
        /// Sent to the server, no answer yet.
        case pending
    }

    public let title: String
    public let detail: String?
    public let tone: Tone

    public init(title: String, detail: String? = nil, tone: Tone) {
        self.title = title
        self.detail = detail
        self.tone = tone
    }

    static func amountText(_ amount: Amount) -> String {
        let value =
            amount.value.truncatingRemainder(dividingBy: 1) == 0
            ? String(Int(amount.value)) : String(amount.value)
        return "\(value) \(amount.unit)"
    }
}

extension RecountSession {
    /// What the walk knows about a code in view. A location label names the bin it belongs to;
    /// a product or barcode is matched against the expected rows exactly as `submit` matches it.
    public func annotation(forScanned raw: String) -> ShelfAnnotation? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let bin = currentBin, !trimmed.isEmpty else { return nil }

        if let parsed = Shortcode.parse(trimmed), parsed.key == .location {
            let id = LocationCode(parsed.code)
            let name = tree?[id]?.name ?? parsed.code
            return ShelfAnnotation(
                title: name, detail: id == bin.id ? "This bin" : "Another bin",
                tone: id == bin.id ? .verified : .unexpected)
        }
        guard case .success(let code) = ScanCode.classify(trimmed) else { return nil }
        guard let state = row(matching: code) else {
            return ShelfAnnotation(title: "Not in this bin", tone: .unexpected)
        }
        let expected = ShelfAnnotation.amountText(state.row.amount)
        switch state.resolution {
        case nil:
            return ShelfAnnotation(
                title: state.row.product.name, detail: "\(expected) expected", tone: .expected)
        case .verify:
            return ShelfAnnotation(title: state.row.product.name, detail: "\(expected) ✓", tone: .verified)
        case .adjust(let amount):
            return ShelfAnnotation(
                title: state.row.product.name, detail: "→ \(ShelfAnnotation.amountText(amount))",
                tone: .verified)
        case .remove:
            return ShelfAnnotation(title: state.row.product.name, detail: "Removed", tone: .verified)
        case .relocate(_, let name):
            return ShelfAnnotation(title: state.row.product.name, detail: "→ \(name)", tone: .verified)
        }
    }
}

extension ScanSession {
    /// What this sweep has already learned about a code in view: the product a scan resolved
    /// to and how it landed. Nothing before the first scan of that code.
    public func annotation(forScanned raw: String) -> ShelfAnnotation? {
        guard let key = Self.key(forScanned: raw), let seen = scanned[key] else { return nil }
        switch seen.status {
        case .pending:
            return ShelfAnnotation(title: seen.label, detail: "Scanning…", tone: .pending)
        case .added:
            return ShelfAnnotation(title: seen.label, detail: "Added ×\(seen.count)", tone: .verified)
        case .confirmed:
            return ShelfAnnotation(title: seen.label, detail: "Already here ×\(seen.count)", tone: .verified)
        case .queued:
            return ShelfAnnotation(title: seen.label, detail: "Stray — decide below", tone: .unexpected)
        case .failed(let message):
            return ShelfAnnotation(title: seen.label, detail: message, tone: .unexpected)
        }
    }
}
