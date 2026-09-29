package actions

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type targetFixture struct {
	Protected [][2]string `json:"protected"`
	Allowed   [][2]string `json:"allowed"`
	Invalid   [][2]string `json:"invalid"`
}

func TestTargetsMatchTheSharedFixture(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "packages", "protocol", "src", "fixtures", "targets.json"))
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var fixture targetFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatalf("decode fixture: %v", err)
	}
	for _, pair := range fixture.Protected {
		if !ValidTarget(pair[0], pair[1]) || !Protected(pair[0], pair[1]) {
			t.Errorf("%v should be a valid, protected target", pair)
		}
	}
	for _, pair := range fixture.Allowed {
		if !ValidTarget(pair[0], pair[1]) || Protected(pair[0], pair[1]) {
			t.Errorf("%v should be a valid, unprotected target", pair)
		}
	}
	for _, pair := range fixture.Invalid {
		if ValidTarget(pair[0], pair[1]) {
			t.Errorf("%q should be invalid", pair)
		}
	}
}

func TestTargetNamesStopAt128Characters(t *testing.T) {
	if !ValidTarget("docker", strings.Repeat("a", 128)) || ValidTarget("docker", strings.Repeat("a", 129)) {
		t.Fatal("the name limit is 128 characters")
	}
}

func TestOperatingSystemUnitsAreMarkedAsSystem(t *testing.T) {
	for _, name := range []string{"cron.service", "snapd.seeded.service", "cloud-init.service", "lvm2-monitor.service", "ufw.service"} {
		if !systemUnit(name) {
			t.Errorf("%s should be a system unit", name)
		}
	}
	for _, name := range []string{"nginx.service", "cronicle.service"} {
		if systemUnit(name) {
			t.Errorf("%s should not be a system unit", name)
		}
	}
}
