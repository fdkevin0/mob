import Foundation
@testable import MobKit

/// A `DeliberationService` test double that replays a fixed script of events with
/// no network or model, and records the director steering it receives. This is
/// the client-side seam harness (PRD Seam 1) every later slice reuses to assert
/// render/steering behavior deterministically.
final class ScriptedDeliberationService: DeliberationService, @unchecked Sendable {
    private let script: [DeliberationStreamEvent]
    private let failAfter: Int?
    private let awaitSteeringCount: Int?

    /// Steering actions observed on the stream, captured for assertion.
    private let recorded = Recorder()

    /// - Parameters:
    ///   - script: events yielded in order to the caller.
    ///   - failAfter: if set, throw after yielding this many events (to exercise
    ///     mid-stream failure handling).
    ///   - awaitSteeringCount: if set, the stream does not finish until this many
    ///     steering actions have been received, so steering tests are deterministic
    ///     rather than racing the script to completion.
    init(
        script: [DeliberationStreamEvent],
        failAfter: Int? = nil,
        awaitSteeringCount: Int? = nil
    ) {
        self.script = script
        self.failAfter = failAfter
        self.awaitSteeringCount = awaitSteeringCount
    }

    var receivedSteering: [SteeringAction] {
        get async { await recorded.actions }
    }

    func deliberate(
        start: StartDeliberation,
        steering: AsyncStream<SteeringAction>
    ) -> AsyncThrowingStream<DeliberationStreamEvent, Error> {
        let script = script
        let failAfter = failAfter
        let awaitSteeringCount = awaitSteeringCount
        let recorded = recorded
        return AsyncThrowingStream { continuation in
            let drain = Task {
                for await action in steering {
                    await recorded.append(action)
                }
            }
            let producer = Task {
                var emitted = 0
                for event in script {
                    if let failAfter, emitted >= failAfter {
                        continuation.finish(throwing: ScriptedError.injected)
                        return
                    }
                    continuation.yield(event)
                    emitted += 1
                    // Let the consumer interleave (e.g. send steering) between events.
                    await Task.yield()
                }
                // For steering tests: hold the stream open until the expected
                // director actions have been observed, so the assertion is not
                // racing the script to completion.
                if let awaitSteeringCount {
                    while await recorded.count < awaitSteeringCount, !Task.isCancelled {
                        await Task.yield()
                    }
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in
                producer.cancel()
                drain.cancel()
            }
        }
    }

    enum ScriptedError: Error { case injected }

    private actor Recorder {
        private(set) var actions: [SteeringAction] = []
        var count: Int { actions.count }
        func append(_ action: SteeringAction) { actions.append(action) }
    }
}
