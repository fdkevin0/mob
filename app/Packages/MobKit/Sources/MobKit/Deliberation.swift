import Foundation

/// The reserved persona id under which the moderator/orchestrator speaks. Mirrors
/// the constant documented in the proto contract.
public let moderatorPersonaID = "__moderator__"

/// App-facing mirror of the proto `DeliberationStatus`, so views and view models
/// never import generated types directly.
public enum DeliberationPhase: Sendable, Equatable {
    case idle
    case assembling
    case debating
    case steering
    case synthesizing
    case done
    case error

    init(_ proto: Mob_V1_DeliberationStatus) {
        switch proto {
        case .assembling: self = .assembling
        case .debating: self = .debating
        case .steering: self = .steering
        case .synthesizing: self = .synthesizing
        case .done: self = .done
        case .error: self = .error
        case .unspecified, .UNRECOGNIZED: self = .idle
        }
    }

    public var label: String {
        switch self {
        case .idle: return "Idle"
        case .assembling: return "Assembling"
        case .debating: return "Debating"
        case .steering: return "Steering"
        case .synthesizing: return "Synthesizing"
        case .done: return "Done"
        case .error: return "Error"
        }
    }
}

/// One persona as sent to the backend on each deliberation. The durable copy
/// lives in SwiftData on the app side; this is the wire-facing shape.
public struct PersonaSpec: Sendable, Equatable, Identifiable {
    public let id: String
    public var name: String
    public var traits: [String]
    public var systemPrompt: String
    public var tier: TaskTier

    public init(
        id: String,
        name: String,
        traits: [String] = [],
        systemPrompt: String = "",
        tier: TaskTier = .standard
    ) {
        self.id = id
        self.name = name
        self.traits = traits
        self.systemPrompt = systemPrompt
        self.tier = tier
    }
}

/// App-facing mirror of the proto `TaskTier` (ADR 0002).
public enum TaskTier: Sendable, Equatable {
    case flagship   // T1
    case high       // T2
    case standard   // T3 (default)
    case fast       // T4

    var proto: Mob_V1_TaskTier {
        switch self {
        case .flagship: return .t1Flagship
        case .high: return .t2High
        case .standard: return .t3Standard
        case .fast: return .t4Fast
        }
    }
}

/// A single contiguous run of speech by one speaker, accumulated from token
/// deltas. The transcript is an ordered list of these.
public struct TranscriptTurn: Sendable, Equatable, Identifiable {
    public let id: Int
    public let speakerID: String
    public internal(set) var text: String

    public var isModerator: Bool { speakerID == moderatorPersonaID }
}

/// The moderator's final structured outcome.
public struct SynthesisResult: Sendable, Equatable {
    public let recommendation: String
    public let tensions: [String]
    public let dissents: [String]
}

/// Configuration for one deliberation run.
public struct RunConfig: Sendable, Equatable {
    public var roundCap: UInt32
    public var convergenceHint: String

    public init(roundCap: UInt32 = 6, convergenceHint: String = "") {
        self.roundCap = roundCap
        self.convergenceHint = convergenceHint
    }
}
