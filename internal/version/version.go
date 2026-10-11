// Package version names Mob builds. Stable releases are tagged vX.Y.Z; every
// other build is named {date}.{sha}: the UTC date of the commit it comes from
// and that commit's short hash, for example 20261011.c0502b6 (docs/adr/0057).
package version

import (
	"regexp"
	"runtime/debug"
	"time"
)

// Dev names a build without commit information, such as go run or go test.
const Dev = "dev"

// Current is the running build's version. Go records the commit of any build
// made inside a Git checkout, so nightly builds need no linker flags.
var Current = fromBuild()

// release is set to the stable tag by the release build:
// -ldflags "-X github.com/fdkevin0/mob/internal/version.release=v0.1.0".
var release string

var (
	nightly = regexp.MustCompile(`^\d{8}\.[0-9a-f]{7}$`)
	stable  = regexp.MustCompile(`^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$`)
)

// Valid reports whether v names a published release, nightly or stable.
func Valid(v string) bool { return nightly.MatchString(v) || stable.MatchString(v) }

// Stable reports whether v names a stable release.
func Stable(v string) bool { return stable.MatchString(v) }

// DownloadURL is where a release can be downloaded.
func DownloadURL(v string) string { return "https://github.com/fdkevin0/mob/releases/tag/" + v }

func fromBuild() string {
	if Stable(release) {
		return release
	}
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return Dev
	}
	// go install github.com/fdkevin0/mob/cmd/mob@v0.1.0 builds from the module
	// cache, which carries the tag but no VCS settings.
	if Stable(info.Main.Version) {
		return info.Main.Version
	}
	return format(info.Settings)
}

// format builds the version from Go's VCS build settings. A build with
// uncommitted changes is marked, since it is not the named commit.
func format(settings []debug.BuildSetting) string {
	var revision, at string
	modified := false
	for _, s := range settings {
		switch s.Key {
		case "vcs.revision":
			revision = s.Value
		case "vcs.time":
			at = s.Value
		case "vcs.modified":
			modified = s.Value == "true"
		}
	}
	committed, err := time.Parse(time.RFC3339, at)
	if len(revision) < 7 || err != nil {
		return Dev
	}
	v := committed.UTC().Format("20060102") + "." + revision[:7]
	if modified {
		v += "-dirty"
	}
	return v
}
