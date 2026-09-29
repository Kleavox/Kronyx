package reporter

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHeartbeatResponseCarriesActionsAndARefresh(t *testing.T) {
	var response HeartbeatResponse
	body := `{"ok":true,"intervalSeconds":60,"configVersion":"v1","refresh":true,"actions":[{"id":"0b4f4f53-7d1c-4b55-9a39-2f0a0d6c1a01","kind":"docker","name":"adguard","action":"restart","expiresAt":"2026-09-29T10:10:00.000Z"}]}`
	if err := json.Unmarshal([]byte(body), &response); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !response.Refresh || len(response.Actions) != 1 || response.Actions[0].Name != "adguard" || response.Actions[0].Action != "restart" {
		t.Fatalf("unexpected response: %#v", response)
	}
}

func TestPostActionsSendsTheReportAndReadsTheHash(t *testing.T) {
	var path, auth, body string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path, auth = r.URL.Path, r.Header.Get("Authorization")
		raw, _ := io.ReadAll(r.Body)
		body = string(raw)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"inventoryHash":"abc"}`))
	}))
	defer server.Close()

	code := 1
	empty := []ServiceEntry{}
	response, err := New(server.URL, "token", "0.6.0").PostActions(context.Background(), ActionsReport{
		NodeID:    "n",
		Results:   []ActionResult{{ID: "r", OK: false, ExitCode: &code, Output: "Job failed", FinishedAt: "t"}},
		Inventory: &InventoryReport{Hash: "h", Services: &empty},
	})
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	if path != "/api/agent/actions" || auth != "Bearer token" {
		t.Fatalf("unexpected request %s %q", path, auth)
	}
	want := `{"nodeId":"n","results":[{"id":"r","ok":false,"exitCode":1,"output":"Job failed","finishedAt":"t"}],"inventory":{"hash":"h","services":[]}}`
	if body != want {
		t.Fatalf("body\n got %s\nwant %s", body, want)
	}
	if response.InventoryHash == nil || *response.InventoryHash != "abc" {
		t.Fatalf("unexpected response %#v", response)
	}
}

func TestAHashOnlyReportLeavesServicesOut(t *testing.T) {
	encoded, err := json.Marshal(ActionsReport{NodeID: "n", Inventory: &InventoryReport{Hash: "h"}})
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) != `{"nodeId":"n","inventory":{"hash":"h"}}` {
		t.Fatalf("unexpected %s", encoded)
	}
}
