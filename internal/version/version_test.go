package version

import (
	"runtime/debug"
	"testing"
)

func TestFormat(t *testing.T) {
	build := func(pairs ...string) []debug.BuildSetting {
		var settings []debug.BuildSetting
		for i := 0; i < len(pairs); i += 2 {
			settings = append(settings, debug.BuildSetting{Key: pairs[i], Value: pairs[i+1]})
		}
		return settings
	}
	for _, tc := range []struct {
		settings []debug.BuildSetting
		want     string
	}{
		{build("vcs.revision", "c0502b6c6776db61d16bcdf5eaff4a0a1ad9e4bc", "vcs.time", "2026-10-11T23:30:00-02:00"), "20261012.c0502b6"},
		{build("vcs.revision", "c0502b6c6776db61", "vcs.time", "2026-10-11T05:00:00Z", "vcs.modified", "true"), "20261011.c0502b6-dirty"},
		{build("vcs.time", "2026-10-11T05:00:00Z"), Dev},
		{build("vcs.revision", "c0502b6c6776db61"), Dev},
		{nil, Dev},
	} {
		if got := format(tc.settings); got != tc.want {
			t.Errorf("%v: got %q, want %q", tc.settings, got, tc.want)
		}
	}
	if !Valid("20261011.c0502b6") || Valid("20261011.c0502b6-dirty") || Valid(Dev) {
		t.Fatal("Valid accepts only release versions")
	}
}
