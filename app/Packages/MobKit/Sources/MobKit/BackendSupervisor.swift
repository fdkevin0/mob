import Foundation

/// Where the backend lives and how to reach it.
public struct BackendEndpoint: Sendable, Equatable {
    public var host: String
    public var port: Int

    public init(host: String, port: Int) {
        self.host = host
        self.port = port
    }
}

/// How the app obtains a running backend (ADR 0001): supervise a local container
/// in self-host mode, or dial a configured hosted endpoint.
public enum BackendMode: Sendable, Equatable {
    /// Self-host: pull/run/health-check/tear-down a local container.
    case selfHost(image: String, port: Int)
    /// Hosted: dial an already-running endpoint.
    case hosted(BackendEndpoint)
}

/// Errors surfaced when the backend can't be made ready (PRD story 34).
public enum BackendError: Error, Equatable {
    case containerStartFailed(String)
    case unreachable(host: String, port: Int)
    case stopped
}

/// Supervises the backend so the director never touches a terminal.
///
/// Slice 1 self-host uses Apple's `container` CLI (the containerization
/// framework's shipped interface) behind an injectable `CommandRunner`, and a
/// TCP reachability probe for health. ADR 0001's intent is the framework's Swift
/// API; swapping this implementation to that API is a later, isolated change
/// because the rest of the app depends only on `BackendSupervisor`.
public protocol BackendSupervisor: Sendable {
    /// Make the backend ready and return where to dial it. Idempotent enough to
    /// call once per app session.
    func start() async throws -> BackendEndpoint
    /// Tear down anything this supervisor started. Safe to call if not started.
    func stop() async
}

/// Runs an external command; injectable so supervision logic is testable without
/// actually spawning containers.
public protocol CommandRunner: Sendable {
    /// Run `executable` with `arguments`; return (exitCode, stdout). Throws only
    /// if the process could not be launched.
    func run(_ executable: String, _ arguments: [String]) async throws -> (Int32, String)
}

/// Probes whether a TCP endpoint accepts connections; injectable for tests.
public protocol ReachabilityProbe: Sendable {
    func isReachable(host: String, port: Int) async -> Bool
}

/// The default self-host supervisor: drives the `container` CLI and waits for the
/// gRPC port to accept connections.
public actor ContainerBackendSupervisor: BackendSupervisor {
    private let image: String
    private let port: Int
    private let containerName: String
    private let runner: CommandRunner
    private let probe: ReachabilityProbe
    private let containerExecutable: String
    private let healthTimeout: Duration
    private let pollInterval: Duration

    private var started = false

    public init(
        image: String,
        port: Int = 50051,
        containerName: String = "mob-backend",
        runner: CommandRunner = ProcessCommandRunner(),
        probe: ReachabilityProbe = TCPReachabilityProbe(),
        containerExecutable: String = "/opt/homebrew/bin/container",
        healthTimeout: Duration = .seconds(30),
        pollInterval: Duration = .milliseconds(300)
    ) {
        self.image = image
        self.port = port
        self.containerName = containerName
        self.runner = runner
        self.probe = probe
        self.containerExecutable = containerExecutable
        self.healthTimeout = healthTimeout
        self.pollInterval = pollInterval
    }

    public func start() async throws -> BackendEndpoint {
        // Best-effort cleanup of a stale container from a previous crash.
        _ = try? await runner.run(containerExecutable, ["rm", "-f", containerName])

        let (code, output) = try await runner.run(
            containerExecutable,
            [
                "run", "--detach",
                "--name", containerName,
                "--publish", "\(port):\(port)",
                image,
            ]
        )
        guard code == 0 else {
            throw BackendError.containerStartFailed(output)
        }

        let endpoint = BackendEndpoint(host: "127.0.0.1", port: port)
        try await waitUntilHealthy(endpoint)
        started = true
        return endpoint
    }

    public func stop() async {
        guard started else { return }
        _ = try? await runner.run(containerExecutable, ["rm", "-f", containerName])
        started = false
    }

    private func waitUntilHealthy(_ endpoint: BackendEndpoint) async throws {
        let deadline = ContinuousClock.now + healthTimeout
        while ContinuousClock.now < deadline {
            if await probe.isReachable(host: endpoint.host, port: endpoint.port) {
                return
            }
            try? await Task.sleep(for: pollInterval)
        }
        throw BackendError.unreachable(host: endpoint.host, port: endpoint.port)
    }
}

/// A trivial supervisor for hosted mode: nothing to start, just hand back the
/// configured endpoint after confirming it is reachable.
public struct HostedBackendSupervisor: BackendSupervisor {
    public let endpoint: BackendEndpoint
    private let probe: ReachabilityProbe

    public init(endpoint: BackendEndpoint, probe: ReachabilityProbe = TCPReachabilityProbe()) {
        self.endpoint = endpoint
        self.probe = probe
    }

    public func start() async throws -> BackendEndpoint {
        guard await probe.isReachable(host: endpoint.host, port: endpoint.port) else {
            throw BackendError.unreachable(host: endpoint.host, port: endpoint.port)
        }
        return endpoint
    }

    public func stop() async {}
}

/// Builds the configured supervisor for a mode.
public func makeSupervisor(for mode: BackendMode) -> BackendSupervisor {
    switch mode {
    case .selfHost(let image, let port):
        return ContainerBackendSupervisor(image: image, port: port)
    case .hosted(let endpoint):
        return HostedBackendSupervisor(endpoint: endpoint)
    }
}
