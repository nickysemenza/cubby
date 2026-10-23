import Foundation

/// Wire membership checks used before choosing a forward-compatible union's typed branch.
public enum NativeWireMatch {
    public static func string(
        _ value: JSONValue, format: String?, pattern: String?, minimum: Int?, maximum: Int?
    ) -> Bool {
        guard let string = value.stringValue else { return false }
        if let minimum, string.utf16.count < minimum { return false }
        if let maximum, string.utf16.count > maximum { return false }
        if let pattern {
            guard let expression = try? NSRegularExpression(pattern: pattern),
                expression.firstMatch(in: string, range: NSRange(string.startIndex..., in: string)) != nil
            else { return false }
        }
        switch format {
        case "date": return PlainDate(rawValue: string).date(in: .gmt) != nil
        case "date-time":
            return (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(string)) != nil
                || (try? Date.ISO8601FormatStyle(includingFractionalSeconds: false).parse(string)) != nil
        default: return true
        }
    }
}
