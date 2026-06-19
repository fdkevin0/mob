import SwiftUI
import MobKit

/// Coordinates one deliberation for the UI: brings the backend up (self-host
/// container supervision, ADR 0001), dials gRPC at the resolved endpoint, and
/// drives a `DeliberationViewModel`. This is the app-level glue the PRD covers
/// with a smoke test rather than unit tests; all the tested logic lives in MobKit.
@MainActor
@Observable
final class DeliberationCoordinator {
    enum ConnectionState: Equatable {
        case idle
        case startingBackend
        case connected
        case failed(String)
    }

    private(set) var connection: ConnectionState = .idle
    private(set) var viewModel: DeliberationViewModel?

    /// Self-host by default (ADR 0001): supervise a local container image.
    private let mode: BackendMode
    private var supervisor: BackendSupervisor?

    init(mode: BackendMode = .selfHost(image: "mob-backend:dev", port: 50051)) {
        self.mode = mode
    }

    /// The Slice 1 placeholder cast (issue #2): a minimal two-persona cast so the
    /// canned backend has speakers to attribute. Real persona authoring is a later
    /// slice; until then the starter voices live here.
    static let placeholderCast: [PersonaSpec] = [
        PersonaSpec(
            id: "pragmatist",
            name: "The Pragmatist",
            traits: ["grounded", "cost-aware"],
            systemPrompt: "Argue from feasibility and long-term cost."
        ),
        PersonaSpec(
            id: "visionary",
            name: "The Visionary",
            traits: ["bold", "speed-first"],
            systemPrompt: "Argue from ambition and speed of learning."
        ),
    ]

    var isBusy: Bool {
        if connection == .startingBackend { return true }
        return viewModel?.isRunning ?? false
    }

    func start(problem: String) async {
        let trimmed = problem.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !isBusy else { return }

        connection = .startingBackend
        let supervisor = makeSupervisor(for: mode)
        self.supervisor = supervisor

        let endpoint: BackendEndpoint
        do {
            endpoint = try await supervisor.start()
        } catch {
            connection = .failed(describe(error))
            return
        }

        connection = .connected
        let service = GRPCDeliberationService(host: endpoint.host, port: endpoint.port)
        let vm = DeliberationViewModel(service: service)
        viewModel = vm
        await vm.run(
            start: StartDeliberation(cast: Self.placeholderCast, problem: trimmed)
        )
    }

    func shutdown() async {
        await supervisor?.stop()
        supervisor = nil
    }

    private func describe(_ error: Error) -> String {
        switch error {
        case BackendError.containerStartFailed(let detail):
            return "The backend container failed to start: \(detail)"
        case BackendError.unreachable(let host, let port):
            return "The backend at \(host):\(port) is unreachable. Is the container running?"
        case BackendError.stopped:
            return "The backend was stopped."
        default:
            return error.localizedDescription
        }
    }
}

/// The live deliberation screen: pose a problem, watch the canned debate stream
/// token-by-token with speaker attribution, mirror the status, and read the
/// synthesis (Slice 1, issue #2).
struct DeliberationScreen: View {
    @State private var coordinator = DeliberationCoordinator()
    @State private var problem: String = "Should we optimize for cost or for speed of learning?"

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            header
            problemEntry
            Divider()
            content
        }
        .padding(20)
        .frame(minWidth: 480, minHeight: 560)
    }

    private var header: some View {
        HStack {
            Text("Mob").font(.largeTitle.bold())
            Spacer()
            if let vm = coordinator.viewModel {
                StatusBadge(phase: vm.phase)
            } else if coordinator.connection == .startingBackend {
                StatusBadge(phase: .assembling, overrideLabel: "Starting backend")
            }
        }
    }

    private var problemEntry: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Pose a problem to the mob").font(.headline)
            TextEditor(text: $problem)
                .font(.body)
                .frame(height: 70)
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(.quaternary))
                .disabled(coordinator.isBusy)
            HStack {
                Spacer()
                Button {
                    let problem = problem
                    Task { await coordinator.start(problem: problem) }
                } label: {
                    Label("Convene the mob", systemImage: "play.fill")
                }
                .keyboardShortcut(.return, modifiers: .command)
                .disabled(coordinator.isBusy || problem.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        if case .failed(let message) = coordinator.connection {
            ErrorBanner(message: message)
        } else if let vm = coordinator.viewModel {
            TranscriptView(viewModel: vm)
        } else {
            ContentUnavailableView(
                "No deliberation yet",
                systemImage: "bubble.left.and.bubble.right",
                description: Text("Pose a problem and convene the mob to watch them deliberate.")
            )
        }
    }
}

private struct TranscriptView: View {
    let viewModel: DeliberationViewModel

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    ForEach(viewModel.transcript) { turn in
                        TurnRow(turn: turn, isSpeaking: turn.speakerID == viewModel.currentSpeakerID)
                            .id(turn.id)
                    }
                    if let synthesis = viewModel.synthesis {
                        SynthesisCard(synthesis: synthesis)
                    }
                    if let error = viewModel.errorMessage {
                        ErrorBanner(message: error)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .onChange(of: viewModel.transcript.last?.text) { _, _ in
                if let last = viewModel.transcript.last {
                    withAnimation { proxy.scrollTo(last.id, anchor: .bottom) }
                }
            }
        }
    }
}

private struct TurnRow: View {
    let turn: TranscriptTurn
    let isSpeaking: Bool

    private var speakerName: String {
        turn.isModerator ? "Moderator" : displayName(for: turn.speakerID)
    }

    private func displayName(for id: String) -> String {
        DeliberationCoordinator.placeholderCast.first { $0.id == id }?.name ?? id
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Image(systemName: turn.isModerator ? "person.badge.shield.checkmark" : "person.fill")
                    .foregroundStyle(turn.isModerator ? .orange : .blue)
                Text(speakerName).font(.subheadline.bold())
                if isSpeaking {
                    Text("speaking…").font(.caption).foregroundStyle(.secondary)
                }
            }
            Text(turn.text)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(12)
        .background(turn.isModerator ? Color.orange.opacity(0.08) : Color.blue.opacity(0.06))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }
}

private struct SynthesisCard: View {
    let synthesis: SynthesisResult

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Synthesis", systemImage: "checkmark.seal.fill").font(.headline)
            Text(synthesis.recommendation).font(.body)
            if !synthesis.tensions.isEmpty {
                section(title: "Tensions", items: synthesis.tensions)
            }
            if !synthesis.dissents.isEmpty {
                section(title: "Dissents", items: synthesis.dissents)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.green.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    private func section(title: String, items: [String]) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.caption.bold()).foregroundStyle(.secondary)
            ForEach(items, id: \.self) { item in
                Text("• \(item)").font(.callout)
            }
        }
    }
}

private struct StatusBadge: View {
    let phase: DeliberationPhase
    var overrideLabel: String?

    var body: some View {
        HStack(spacing: 6) {
            Circle().fill(color).frame(width: 8, height: 8)
            Text(overrideLabel ?? phase.label).font(.caption.bold())
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(.quaternary, in: Capsule())
    }

    private var color: Color {
        switch phase {
        case .idle: return .gray
        case .assembling, .steering: return .yellow
        case .debating: return .blue
        case .synthesizing: return .orange
        case .done: return .green
        case .error: return .red
        }
    }
}

private struct ErrorBanner: View {
    let message: String

    var body: some View {
        Label(message, systemImage: "exclamationmark.triangle.fill")
            .foregroundStyle(.red)
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.red.opacity(0.08))
            .clipShape(RoundedRectangle(cornerRadius: 10))
    }
}

#Preview {
    DeliberationScreen()
}
