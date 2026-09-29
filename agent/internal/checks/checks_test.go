package checks

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Kleavox/krynodes/agent/internal/reporter"
)

func TestHTTPCheck(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	result := Run(context.Background(), reporter.Check{
		ID: "check", Kind: "HTTP", Target: server.URL, TimeoutSeconds: 2,
	})
	if result.Status != "UP" {
		t.Fatalf("expected UP, got %s", result.Status)
	}
}

func TestHTTPCheckIdentifiesAsTheKrynodesAgent(t *testing.T) {
	var got string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Get("User-Agent")
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	Run(context.Background(), reporter.Check{
		ID: "check", Kind: "HTTP", Target: server.URL, TimeoutSeconds: 2,
	})
	if got != "kry-agent-check" {
		t.Fatalf("expected User-Agent kry-agent-check, got %q", got)
	}
}

func TestRejectsUnsupportedCheck(t *testing.T) {
	result := Run(context.Background(), reporter.Check{
		ID: "check", Kind: "SHELL", Target: "echo unsafe", TimeoutSeconds: 2,
	})
	if result.Status != "DOWN" {
		t.Fatalf("expected DOWN, got %s", result.Status)
	}
}
