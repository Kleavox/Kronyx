package host

import "testing"

func TestDescribeNamesTheDistribution(t *testing.T) {
	cases := []struct {
		name, osRelease, debianVersion, want string
	}{
		{
			name: "debian point release",
			osRelease: `PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"
NAME="Debian GNU/Linux"
VERSION_ID="12"
VERSION="12 (bookworm)"
ID=debian`,
			debianVersion: "12.10\n",
			want:          "Debian 12.10",
		},
		{
			name: "ubuntu point release",
			osRelease: `PRETTY_NAME="Ubuntu 24.04.1 LTS"
NAME="Ubuntu"
VERSION_ID="24.04"
VERSION="24.04.1 LTS (Noble Numbat)"
ID=ubuntu`,
			want: "Ubuntu 24.04.1",
		},
		{
			name: "alpine without a VERSION line",
			osRelease: `NAME="Alpine Linux"
ID=alpine
VERSION_ID=3.20.3
PRETTY_NAME="Alpine Linux v3.20"`,
			want: "Alpine Linux 3.20.3",
		},
		{
			name: "debian testing has no version number",
			osRelease: `PRETTY_NAME='Debian GNU/Linux trixie/sid'
NAME="Debian GNU/Linux"
ID=debian`,
			debianVersion: "trixie/sid\n",
			want:          "Debian GNU/Linux trixie/sid",
		},
		{
			name: "no os-release at all",
			want: "linux",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := Describe(tc.osRelease, tc.debianVersion, "linux"); got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}
