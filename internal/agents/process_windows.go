package agents

import (
	"os/exec"
	"strconv"
)

func group(*exec.Cmd) {}

// kill ends cmd and the processes it started.
func kill(cmd *exec.Cmd) {
	if exec.Command("taskkill", "/T", "/F", "/PID", strconv.Itoa(cmd.Process.Pid)).Run() != nil {
		_ = cmd.Process.Kill()
	}
}
