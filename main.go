package main

import (
	"fmt"
	"os"

	"github.com/fdkevin0/mob/internal/local"
	"github.com/fdkevin0/mob/webapp"
	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
)

type Desktop struct {
	connection local.Connection
	err        error
}

// Connection is the local service, or why the desktop could not reach it.
func (d *Desktop) Connection() (local.Connection, error) { return d.connection, d.err }

func main() {
	if err := runDesktop(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func runDesktop() error {
	config, err := local.LoadConfig()
	if err != nil {
		return err
	}
	// The window opens even when the service cannot start, such as for a
	// database from an unsupported release, so the reason reaches the user.
	desktop := &Desktop{}
	connection, close, err := local.ConnectOrStart(config, webapp.Assets())
	if err != nil {
		desktop.err = err
	} else {
		defer close()
		desktop.connection = connection
	}
	return wails.Run(&options.App{Title: "Mob", Width: 1100, Height: 780, MinWidth: 640, MinHeight: 480,
		AssetServer: &assetserver.Options{Assets: webapp.Assets()}, Bind: []interface{}{desktop},
		BackgroundColour: &options.RGBA{R: 249, G: 249, B: 247, A: 255}})
}
