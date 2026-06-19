import Testing
@testable import MobKit

/// Backend supervision tests: drive the supervisors against fake command/probe
/// dependencies so container lifecycle and health-check behavior is asserted
/// deterministically, with no real container and no real network (PRD story 34).
struct BackendSupervisorTests {

    /// Records the commands it was asked to run and returns scripted results.
    final class FakeRunner: CommandRunner, @unchecked Sendable {
        private let result: (Int32, String)
        let recorder = Recorder()

        init(result: (Int32, String) = (0, "")) { self.result = result }

        func run(_ executable: String, _ arguments: [String]) async throws -> (Int32, String) {
            await recorder.record(arguments)
            // The `run --detach` invocation returns the scripted result; cleanup
            // (`rm -f`) always succeeds so it never masks the run outcome.
            if arguments.first == "run" { return result }
            return (0, "")
        }

        actor Recorder {
            private(set) var calls: [[String]] = []
            func record(_ args: [String]) { calls.append(args) }
            var ranContainer: Bool { calls.contains { $0.first == "run" } }
            var removedContainer: Bool { calls.contains { $0.first == "rm" } }
        }
    }

    /// A probe that becomes reachable after a fixed number of polls.
    final class FakeProbe: ReachabilityProbe, @unchecked Sendable {
        private let reachableAfter: Int
        private let counter = Counter()

        init(reachableAfter: Int) { self.reachableAfter = reachableAfter }

        func isReachable(host: String, port: Int) async -> Bool {
            await counter.next() >= reachableAfter
        }

        actor Counter {
            private var n = 0
            func next() -> Int { defer { n += 1 }; return n }
        }
    }

    @Test func startRunsContainerThenReturnsEndpointWhenHealthy() async throws {
        let runner = FakeRunner(result: (0, "container-id"))
        let probe = FakeProbe(reachableAfter: 0) // healthy on first poll
        let supervisor = ContainerBackendSupervisor(
            image: "mob-backend:dev",
            port: 50051,
            runner: runner,
            probe: probe,
            pollInterval: .milliseconds(1)
        )

        let endpoint = try await supervisor.start()

        #expect(endpoint == BackendEndpoint(host: "127.0.0.1", port: 50051))
        #expect(await runner.recorder.ranContainer)
    }

    @Test func startSurfacesContainerStartFailure() async {
        let runner = FakeRunner(result: (1, "no such image"))
        let probe = FakeProbe(reachableAfter: 0)
        let supervisor = ContainerBackendSupervisor(
            image: "bad",
            runner: runner,
            probe: probe,
            pollInterval: .milliseconds(1)
        )

        await #expect(throws: BackendError.containerStartFailed("no such image")) {
            try await supervisor.start()
        }
    }

    @Test func startTimesOutUnreachableAsUnreachableError() async {
        let runner = FakeRunner(result: (0, ""))
        // Never reachable within the (tiny) health timeout.
        let probe = FakeProbe(reachableAfter: .max)
        let supervisor = ContainerBackendSupervisor(
            image: "mob-backend:dev",
            port: 50051,
            runner: runner,
            probe: probe,
            healthTimeout: .milliseconds(20),
            pollInterval: .milliseconds(1)
        )

        await #expect(throws: BackendError.unreachable(host: "127.0.0.1", port: 50051)) {
            try await supervisor.start()
        }
    }

    @Test func stopTearsDownAStartedContainer() async throws {
        let runner = FakeRunner(result: (0, ""))
        let probe = FakeProbe(reachableAfter: 0)
        let supervisor = ContainerBackendSupervisor(
            image: "mob-backend:dev",
            runner: runner,
            probe: probe,
            pollInterval: .milliseconds(1)
        )

        _ = try await supervisor.start()
        await supervisor.stop()

        #expect(await runner.recorder.removedContainer)
    }

    @Test func hostedSupervisorReturnsEndpointWhenReachable() async throws {
        let endpoint = BackendEndpoint(host: "example.com", port: 443)
        let supervisor = HostedBackendSupervisor(
            endpoint: endpoint,
            probe: FakeProbe(reachableAfter: 0)
        )

        #expect(try await supervisor.start() == endpoint)
    }

    @Test func hostedSupervisorThrowsWhenUnreachable() async {
        let endpoint = BackendEndpoint(host: "example.com", port: 443)
        let supervisor = HostedBackendSupervisor(
            endpoint: endpoint,
            probe: FakeProbe(reachableAfter: .max)
        )

        await #expect(throws: BackendError.unreachable(host: "example.com", port: 443)) {
            try await supervisor.start()
        }
    }
}
