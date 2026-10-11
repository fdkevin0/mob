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
	for v, want := range map[string]bool{"20261011.c0502b6": true, "v0.1.0": true, "v1.12.3": true, "20261011.c0502b6-dirty": false, Dev: false, "0.1.0": false, "v0.1": false, "v01.2.3": false, "v0.1.0-rc.1": false} {
		if Valid(v) != want {
			t.Errorf("Valid(%q) = %v, want %v", v, !want, want)
		}
	}
	if !Stable("v0.1.0") || Stable("20261011.c0502b6") {
		t.Error("Stable accepts only vX.Y.Z")
	}
}
