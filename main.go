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
	config     local.Config
	connection local.Connection
	err        error
}

// Connection is the local service, or why the desktop could not reach it.
// The token is read again so a reloaded window follows mob token rotate.
func (d *Desktop) Connection() (local.Connection, error) {
	if d.err != nil {
		return local.Connection{}, d.err
	}
	connection := d.connection
	if current, err := local.Credentials(d.config); err == nil {
		connection.Token = current.Token
	}
	return connection, nil
}

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
	desktop := &Desktop{config: config}
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
