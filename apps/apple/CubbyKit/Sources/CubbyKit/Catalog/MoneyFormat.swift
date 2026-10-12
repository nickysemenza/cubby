import Foundation

/// The one US-dollar spelling: all money is `SUM(Expense.cost)` in USD, written en-US and rounded
/// half away from zero by the Rust formatter the web calls (`ValueFormat.currency`), whatever the
/// device locale.
extension Double {
    public var usd: String { ValueFormat.currency(self) }
}

extension Decimal {
    public var usd: String { ValueFormat.currency(NSDecimalNumber(decimal: self).doubleValue) }
}
