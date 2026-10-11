package chat

type EventKind uint8

const (
	TurnStarted EventKind = iota
	StepStarted
	SegmentStarted
	SegmentDelta
	SegmentFinished
	UsageReported
	ToolInput
	ToolOutput
	ToolFailed
	ApprovalRequested
	StepFinished
	TurnFinished
	TurnAborted
	TurnFailed
)

// Event is an in-process conversation notification, independent of HTTP/SSE.
type Event struct {
	Kind       EventKind
	Segment    string
	MessageID  string
	Reason     string
	Error      string
	ID         string
	Text       string
	Usage      any
	ToolCallID string
	ToolName   string
	Input      any
	Output     any
	ApprovalID string
}
