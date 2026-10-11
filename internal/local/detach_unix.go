//go:build !windows

package local

import (
	"os/exec"
	"syscall"
)

func detach(command *exec.Cmd) { command.SysProcAttr = &syscall.SysProcAttr{Setsid: true} }
