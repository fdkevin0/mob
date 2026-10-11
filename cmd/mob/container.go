package main

import (
	"fmt"
	"strings"

	"github.com/fdkevin0/mob/internal/container"
	"github.com/spf13/cobra"
)

// newRuntime is replaced by tests to run without a container CLI.
var newRuntime = container.New

// containerCommand drives the configured container runtime directly.
func containerCommand(name func() string) *cobra.Command {
	root := &cobra.Command{Use: "container", Short: "Run containers with the platform's runtime (containerd, Apple container, WSL containers)"}
	open := func() (*container.Runtime, error) { return newRuntime(name()) }

	status := &cobra.Command{Use: "status", Short: "Show which container runtime is used and whether it is running", Args: cobra.NoArgs, RunE: func(cmd *cobra.Command, args []string) error {
		r, err := open()
		if err != nil {
			return err
		}
		fmt.Fprintf(cmd.OutOrStdout(), "Container runtime: %s (%s)\n", r.Name, r.Binary)
		if err := r.Check(cmd.Context()); err != nil {
			return err
		}
		fmt.Fprintln(cmd.OutOrStdout(), "Ready.")
		return nil
	}}

	pull := &cobra.Command{Use: "pull IMAGE", Short: "Fetch an image", Args: cobra.ExactArgs(1), RunE: func(cmd *cobra.Command, args []string) error {
		r, err := open()
		if err != nil {
			return err
		}
		return r.Pull(cmd.Context(), args[0])
	}}

	var opts struct {
		env, volumes []string
		workdir      string
		interactive  bool
	}
	run := &cobra.Command{
		Use:   "run [flags] IMAGE [COMMAND...]",
		Short: "Run a command in a new container, removed when it exits",
		Args:  cobra.MinimumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			r, err := open()
			if err != nil {
				return err
			}
			spec := container.Spec{Image: args[0], Command: args[1:], Env: opts.env, Workdir: opts.workdir}
			for _, v := range opts.volumes {
				// Split at the last colon: Windows sources carry a drive letter.
				i := strings.LastIndex(v, ":")
				if i <= 0 {
					return fmt.Errorf("volume %q must be SOURCE:TARGET", v)
				}
				spec.Mounts = append(spec.Mounts, container.Mount{Source: v[:i], Target: v[i+1:]})
			}
			if opts.interactive {
				spec.Stdin = cmd.InOrStdin()
			}
			code, err := r.Stream(cmd.Context(), spec, cmd.OutOrStdout(), cmd.ErrOrStderr())
			if err != nil {
				return err
			}
			if code != 0 {
				return fmt.Errorf("container exited with status %d", code)
			}
			return nil
		},
	}
	// Options after IMAGE belong to the container's command.
	run.Flags().SetInterspersed(false)
	run.Flags().StringArrayVarP(&opts.env, "env", "e", nil, "Set an environment variable (KEY=VALUE, repeatable)")
	run.Flags().StringArrayVarP(&opts.volumes, "volume", "v", nil, "Bind a host path (SOURCE:TARGET, repeatable)")
	run.Flags().StringVarP(&opts.workdir, "workdir", "w", "", "Working directory inside the container")
	run.Flags().BoolVarP(&opts.interactive, "interactive", "i", false, "Pass standard input to the container")

	root.AddCommand(status, pull, run)
	return root
}
