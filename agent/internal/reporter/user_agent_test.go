package reporter

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRequestsIdentifyAsTheKrynodesAgent(t *testing.T) {
	var got string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Get("User-Agent")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"nodeId":"n","intervalSeconds":60,"configVersion":"v","checks":[]}`))
	}))
	defer server.Close()

	if _, err := New(server.URL, "token", "0.4.0").FetchConfig(context.Background()); err != nil {
		t.Fatalf("fetch config: %v", err)
	}
	if got != "kry-agent/0.4.0" {
		t.Fatalf("expected User-Agent kry-agent/0.4.0, got %q", got)
	}
}
