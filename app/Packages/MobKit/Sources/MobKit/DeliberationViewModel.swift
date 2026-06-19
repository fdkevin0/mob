import Foundation
import Observation

/// Drives one live deliberation: opens the stream through a `DeliberationService`,
/// folds the incoming events into an incrementally-rendered transcript, mirrors
/// the status, and exposes director steering controls.
///
/// All the render logic lives here so it can be tested against a fake service
/// replaying a scripted event stream (PRD Seam 1, client side).
@MainActor
@Observable
public final class DeliberationViewModel {
    public private(set) var phase: DeliberationPhase = .idle
    public private(set) var currentSpeakerID: String?
    public private(set) var transcript: [TranscriptTurn] = []
    public private(set) var synthesis: SynthesisResult?
    public private(set) var errorMessage: String?

    private let service: DeliberationService
    private var steeringContinuation: AsyncStream<SteeringAction>.Continuation?
    private var nextTurnID = 0

    public init(service: DeliberationService) {
        self.service = service
    }

    /// Whether a deliberation is actively running (stream open, not yet ended).
    public var isRunning: Bool {
        switch phase {
        case .idle, .done, .error: return false
        default: return true
        }
    }

    /// Run a deliberation to completion, folding events into observable state.
    public func run(start: StartDeliberation) async {
        reset()

        let (steering, continuation) = AsyncStream<SteeringAction>.makeStream()
        steeringContinuation = continuation

        let events = service.deliberate(start: start, steering: steering)
        do {
            for try await event in events {
                apply(event)
            }
        } catch {
            phase = .error
            errorMessage = error.localizedDescription
        }
        steeringContinuation?.finish()
        steeringContinuation = nil
    }

    // MARK: Director steering

    public func interject(_ text: String) { send(.interject(text)) }
    public func callOn(personaID: String) { send(.callOn(personaID: personaID)) }
    public func cutOff() { send(.cutOff) }
    public func end() { send(.end) }

    private func send(_ action: SteeringAction) {
        steeringContinuation?.yield(action)
    }

    // MARK: Event folding

    private func apply(_ event: DeliberationStreamEvent) {
        switch event {
        case .status(let phase):
            self.phase = phase
        case .speakerChanged(let speakerID):
            currentSpeakerID = speakerID
            // Open a fresh turn so a speaker's run is contiguous even if they
            // hold the floor again later.
            transcript.append(TranscriptTurn(id: nextTurnID, speakerID: speakerID, text: ""))
            nextTurnID += 1
        case .token(let speakerID, let text):
            appendToken(speakerID: speakerID, text: text)
        case .synthesis(let result):
            synthesis = result
        case .error(let code, let message):
            phase = .error
            errorMessage = "[\(code)] \(message)"
        }
    }

    private func appendToken(speakerID: String, text: String) {
        // Tokens normally follow a SpeakerChanged, but tolerate a token arriving
        // for a speaker with no open turn (e.g. tokens before the first change).
        if transcript.last?.speakerID == speakerID {
            transcript[transcript.count - 1].text += text
        } else {
            currentSpeakerID = speakerID
            transcript.append(
                TranscriptTurn(id: nextTurnID, speakerID: speakerID, text: text)
            )
            nextTurnID += 1
        }
    }

    private func reset() {
        phase = .idle
        currentSpeakerID = nil
        transcript = []
        synthesis = nil
        errorMessage = nil
        nextTurnID = 0
    }
}
