package reporter

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestAgentConfigMatchesSharedProtocolFixture(t *testing.T) {
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve test path")
	}
	fixturePath := filepath.Join(
		filepath.Dir(currentFile),
		"..", "..", "..",
		"packages", "protocol", "src", "fixtures", "agent-config.json",
	)
	data, err := os.ReadFile(fixturePath)
	if err != nil {
		t.Fatalf("read protocol fixture: %v", err)
	}

	var config AgentConfig
	if err := json.Unmarshal(data, &config); err != nil {
		t.Fatalf("decode protocol fixture: %v", err)
	}
	if config.ConfigVersion != "0123456789abcdef" {
		t.Fatalf("config version missing from Agent protocol: %q", config.ConfigVersion)
	}
	if len(config.Checks) != 1 || config.Checks[0].TimeoutSeconds != 10 {
		t.Fatalf("unexpected checks: %#v", config.Checks)
	}

	encoded, err := json.Marshal(config.Checks[0])
	if err != nil {
		t.Fatalf("encode check: %v", err)
	}
	if strings.Contains(string(encoded), "timeout_seconds") {
		t.Fatalf("database field leaked into Agent protocol: %s", encoded)
	}
	if !strings.Contains(string(encoded), "timeoutSeconds") {
		t.Fatalf("camelCase timeout missing from Agent protocol: %s", encoded)
	}
}
