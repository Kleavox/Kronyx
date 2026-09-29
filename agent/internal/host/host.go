package host

import (
	"os"
	"regexp"
	"runtime"
	"strings"
)

const maxLength = 64

var numericVersion = regexp.MustCompile(`^\d+(\.\d+)*$`)

func OperatingSystem() string {
	release, err := os.ReadFile("/etc/os-release")
	if err != nil {
		release, _ = os.ReadFile("/usr/lib/os-release")
	}
	debian, _ := os.ReadFile("/etc/debian_version")
	return Describe(string(release), string(debian), runtime.GOOS)
}

func Describe(osRelease, debianVersion, fallback string) string {
	fields := parse(osRelease)
	name := strings.TrimSpace(strings.TrimSuffix(fields["NAME"], "GNU/Linux"))
	version := fields["VERSION_ID"]
	if full := strings.Fields(fields["VERSION"]); len(full) > 0 &&
		version != "" && strings.HasPrefix(full[0], version) {
		version = full[0]
	}
	if point := strings.TrimSpace(debianVersion); fields["ID"] == "debian" &&
		numericVersion.MatchString(point) {
		version = point
	}

	described := fallback
	switch {
	case name != "" && version != "":
		described = name + " " + version
	case fields["PRETTY_NAME"] != "":
		described = fields["PRETTY_NAME"]
	}
	if len(described) > maxLength {
		described = described[:maxLength]
	}
	return described
}

func parse(content string) map[string]string {
	fields := map[string]string{}
	for _, line := range strings.Split(content, "\n") {
		key, value, found := strings.Cut(strings.TrimSpace(line), "=")
		if !found || strings.HasPrefix(key, "#") {
			continue
		}
		fields[key] = strings.Trim(value, `"'`)
	}
	return fields
}
