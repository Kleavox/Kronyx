package config

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestSaveAndLoad(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	err := Save(path, Config{
		Endpoint: "https://krynodes.example.test", NodeID: "node-id",
		Token: "secret", IntervalSeconds: 60,
	})
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Fatalf("expected mode 0600, got %o", info.Mode().Perm())
	}
	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.IntervalSeconds != 60 || cfg.Token != "secret" {
		t.Fatalf("unexpected config: %#v", cfg)
	}
}

func TestRejectsInsecureRemoteEndpoint(t *testing.T) {
	_, err := validate(Config{
		Endpoint: "http://krynodes.example.com", NodeID: "node", Token: "token",
	})
	if err == nil {
		t.Fatal("expected insecure endpoint rejection")
	}
}
