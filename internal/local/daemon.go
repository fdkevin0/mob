package local

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

type RuntimeStatus struct {
	Background  bool   `json:"background"`
	ConfigError string `json:"configError"`
}

func Status(c Config) (RuntimeStatus, error) {
	connection, err := Credentials(c)
	if err != nil {
		return RuntimeStatus{}, err
	}
	req, err := http.NewRequest("GET", connection.URL+"/api/runtime", nil)
	if err != nil {
		return RuntimeStatus{}, err
	}
	req.Header.Set("Authorization", "Bearer "+connection.Token)
	client := http.Client{Timeout: time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return RuntimeStatus{}, errors.New("Mob is not running")
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return RuntimeStatus{}, fmt.Errorf("runtime status HTTP %d", resp.StatusCode)
	}
	var status RuntimeStatus
	err = json.NewDecoder(resp.Body).Decode(&status)
	return status, err
}
func StartBackground(c Config) error {
	if status, err := Status(c); err == nil {
		if status.Background {
			return nil
		}
		return errors.New("Mob is running in a foreground/UI process; close that owner, then run mob start")
	}
	stateDir := c.StateDir
	if stateDir == "" {
		stateDir = c.Dir
	}
	if err := os.MkdirAll(stateDir, 0700); err != nil {
		return err
	}
	log, err := os.OpenFile(filepath.Join(stateDir, "daemon.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer log.Close()
	if err = log.Chmod(0600); err != nil {
		return err
	}
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	args := append([]string{"serve", "--background"}, c.Loader.Arguments()...)
	command := exec.Command(executable, args...)
	command.Env = c.Loader.Environ()
	command.Stdout = log
	command.Stderr = log
	detach(command)
	if err = command.Start(); err != nil {
		return err
	}
	exited := make(chan error, 1)
	go func() { exited <- command.Wait() }()
	timeout := time.NewTimer(15 * time.Second)
	defer timeout.Stop()
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case err := <-exited:
			return fmt.Errorf("background process exited (%v); see %s", err, filepath.Join(stateDir, "daemon.log"))
		case <-timeout.C:
			return fmt.Errorf("background startup timed out; inspect %s and mob status", filepath.Join(stateDir, "daemon.log"))
		case <-tick.C:
			if status, err := Status(c); err == nil && status.Background {
				return nil
			}
		}
	}
}
func StopBackground(c Config) error {
	status, err := Status(c)
	if err != nil {
		return err
	}
	if !status.Background {
		return errors.New("Mob belongs to a foreground/UI process; close that owner to stop it")
	}
	connection, err := Credentials(c)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "POST", connection.URL+"/api/runtime/stop", nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+connection.Token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	resp.Body.Close()
	if resp.StatusCode != 202 {
		return fmt.Errorf("stop HTTP %d", resp.StatusCode)
	}
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return errors.New("shutdown still in progress; check mob status")
		case <-tick.C:
			if _, err := Status(c); err != nil {
				return nil
			}
		}
	}
}
