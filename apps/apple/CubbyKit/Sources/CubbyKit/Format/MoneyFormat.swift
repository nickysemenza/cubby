import Foundation

/// The one US-dollar spelling: all money is `SUM(Expense.cost)` in USD, written en-US and rounded
/// half away from zero by the Rust formatter the web calls (`ValueFormat.currency`), with a
/// signed threshold for nonzero amounts below display precision, whatever the
/// device locale.
extension Double {
    public var usd: String { ValueFormat.currency(self) }
}

extension Decimal {
    public var usd: String { ValueFormat.currency(NSDecimalNumber(decimal: self).doubleValue) }
}

/// AI usage keeps sub-cent precision and identifies incomplete known subtotals.
public func aiCostSubtotal(_ value: Double, unpriced: Int, count: Int? = nil, complete: Bool? = nil) -> String
{
    if value == 0, unpriced == 0, complete == false {
        return "unpriced · coverage unknown"
    }
    if value == 0, unpriced > 0, unpriced >= (count ?? unpriced) {
        return "\(unpriced) unpriced"
    }
    let amount = ValueFormat.currency(value, minFractionDigits: 4, maxFractionDigits: 6)
    return unpriced > 0
        ? "\(amount) known · \(unpriced) unpriced"
        : complete == false ? "\(amount) known · coverage unknown" : amount
}

public func aiBillingReasonLabel(_ reason: String) -> String {
    switch reason {
    case "standard": "Standard billing"
    case "plan": "Plan covered"
    case "cache": "Cached response"
    case "discount": "Discount applied"
    case "local": "On device"
    default: "Billing reason unknown"
    }
}
