package webapp

import (
	"embed"
	"io/fs"
)

// Build the frontend with bun run build before compiling a release binary.
//
//go:embed all:dist
var files embed.FS

func Assets() fs.FS {
	assets, err := fs.Sub(files, "dist")
	if err != nil {
		panic(err)
	}
	return assets
}
