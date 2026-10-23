/// Recursive JSON records keep value semantics while breaking Swift's stored-value cycle.
@propertyWrapper
public struct NativeIndirect<Value: Hashable & Sendable>: Hashable, Sendable {
    private indirect enum Storage: Hashable, Sendable {
        case value(Value)
    }
    private var storage: Storage

    public init(wrappedValue: Value) { storage = .value(wrappedValue) }

    public var wrappedValue: Value {
        get {
            switch storage {
            case .value(let value): value
            }
        }
        set { storage = .value(newValue) }
    }
}
