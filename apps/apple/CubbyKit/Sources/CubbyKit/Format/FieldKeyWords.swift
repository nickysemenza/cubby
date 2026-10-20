/// A field key as the words a label shows.
public enum FieldKeyWords {
    /// `unitPrice` and `unit_price` → `unit Price` and `unit price`: a space at each lowercase-or-digit
    /// to uppercase ASCII boundary and for each underscore, casing left to the caller. A scan, not a
    /// regex: labels are built per row, and a pattern compiled per call dominated them.
    public static func spaced(_ key: String) -> String {
        var result = String.UnicodeScalarView()
        var previous: Unicode.Scalar?
        for scalar in key.unicodeScalars {
            if let previous, isLowerOrDigit(previous), ("A"..."Z").contains(scalar) {
                result.append(" ")
            }
            result.append(scalar == "_" ? " " : scalar)
            previous = scalar
        }
        return String(result)
    }

    private static func isLowerOrDigit(_ scalar: Unicode.Scalar) -> Bool {
        ("a"..."z").contains(scalar) || ("0"..."9").contains(scalar)
    }
}
