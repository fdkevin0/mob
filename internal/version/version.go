// Package version names Mob builds as {date}.{sha}: the UTC date of the commit
// a build comes from and that commit's short hash, for example 20261011.c0502b6.
package version

import (
	"regexp"
	"runtime/debug"
	"time"
)

// Dev names a build without commit information, such as go run or go test.
const Dev = "dev"

// Current is the running build's version. Go records the commit of any build
// made inside a Git checkout, so releases need no linker flags.
var Current = fromBuild()

var pattern = regexp.MustCompile(`^\d{8}\.[0-9a-f]{7}$`)

// Valid reports whether v names a release.
func Valid(v string) bool { return pattern.MatchString(v) }

// DownloadURL is where a release can be downloaded.
func DownloadURL(v string) string { return "https://github.com/fdkevin0/mob/releases/tag/" + v }

func fromBuild() string {
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return Dev
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
