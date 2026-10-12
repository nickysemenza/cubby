import Foundation

/// The declared full-filtered-set totals line for Browse and the CLI, in the server's words
/// (`ListPageMeta.totalLabels`, keyed by total id). A total the server did not word is
/// unavailable, never zero, and nothing is computed from loaded list rows.
public enum ListTotalsSummary {
    public static func line(totals: [ListTotalDescriptor], labels: [String: String]?) -> String? {
        guard !totals.isEmpty else { return nil }
        let values = totals.map { "\($0.label): \(labels?[$0.id] ?? "Unavailable")" }
        return "All matching · \(values.joined(separator: " · "))"
    }
}
