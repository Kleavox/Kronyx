package reporter

import (
	"encoding/json"
	"testing"
)

func TestHeartbeatResponseCarriesAnUpdateInstruction(t *testing.T) {
	var response HeartbeatResponse
	body := `{"ok":true,"intervalSeconds":60,"configVersion":"v1","update":{"version":"0.5.2","requestedAt":"2026-09-28T08:00:00.000Z"}}`
	if err := json.Unmarshal([]byte(body), &response); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if response.Update == nil || response.Update.Version != "0.5.2" || response.Update.RequestedAt != "2026-09-28T08:00:00.000Z" {
		t.Fatalf("unexpected update: %#v", response.Update)
	}
}
