package update

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWriteRequestWritesOnlyWhenTheRequestChanges(t *testing.T) {
	path := filepath.Join(t.TempDir(), "update-request")

	changed, err := WriteRequest(path, "0.5.2", "t1")
	if err != nil || !changed {
		t.Fatalf("first write: changed=%v err=%v", changed, err)
	}
	changed, err = WriteRequest(path, "0.5.2", "t1")
	if err != nil || changed {
		t.Fatalf("repeat write: changed=%v err=%v", changed, err)
	}
	changed, err = WriteRequest(path, "0.5.2", "t2")
	if err != nil || !changed {
		t.Fatalf("retry write: changed=%v err=%v", changed, err)
	}
	content, _ := os.ReadFile(path)
	if string(content) != "0.5.2\nt2\n" {
		t.Fatalf("unexpected request file %q", content)
	}
}

func TestWriteRequestRefusesAnythingButAVersion(t *testing.T) {
	path := filepath.Join(t.TempDir(), "update-request")
	for _, bad := range []string{"../../etc/passwd", "0.5", "v0.5.2", ""} {
		if _, err := WriteRequest(path, bad, "t1"); err == nil {
			t.Fatalf("accepted %q", bad)
		}
	}
}

type release struct {
	binary    []byte
	checksum  string
	signature []byte
}

func signedRelease(t *testing.T, private ed25519.PrivateKey, binary []byte) release {
	t.Helper()
	sum := sha256.Sum256(binary)
	return release{
		binary:    binary,
		checksum:  hex.EncodeToString(sum[:]) + "  krynodes-linux-amd64\n",
		signature: ed25519.Sign(private, binary),
	}
}

type harness struct {
	options Options
	runs    []string
}

func newHarness(t *testing.T, public ed25519.PublicKey, published release) *harness {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/agent-v0.5.2/krynodes-linux-amd64":
			_, _ = w.Write(published.binary)
		case "/agent-v0.5.2/krynodes-linux-amd64.sha256":
			_, _ = w.Write([]byte(published.checksum))
		case "/agent-v0.5.2/krynodes-linux-amd64.sig":
			_, _ = w.Write(published.signature)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)

	dir := t.TempDir()
	binary := filepath.Join(dir, "kry")
	if err := os.WriteFile(binary, []byte("old agent"), 0o755); err != nil {
		t.Fatal(err)
	}
	request := filepath.Join(dir, "update-request")
	if _, err := WriteRequest(request, "0.5.2", "t1"); err != nil {
		t.Fatal(err)
	}
	h := &harness{}
	h.options = Options{
		RequestPath:    request,
		BinaryPath:     binary,
		Base:           server.URL,
		Arch:           "amd64",
		CurrentVersion: "0.5.1",
		PublicKey:      public,
		Client:         server.Client(),
		Run: func(name string, args ...string) error {
			h.runs = append(h.runs, strings.Join(append([]string{filepath.Base(name)}, args...), " "))
			return nil
		},
	}
	return h
}

func keys(t *testing.T) (ed25519.PublicKey, ed25519.PrivateKey) {
	t.Helper()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return public, private
}

func contentOf(t *testing.T, path string) string {
	t.Helper()
	content, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return string(content)
}

func TestApplyInstallsASignedReleaseAndRestarts(t *testing.T) {
	public, private := keys(t)
	h := newHarness(t, public, signedRelease(t, private, []byte("new agent")))

	if err := Apply(h.options); err != nil {
		t.Fatalf("apply: %v", err)
	}
	if got := contentOf(t, h.options.BinaryPath); got != "new agent" {
		t.Fatalf("binary is %q", got)
	}
	if got := contentOf(t, h.options.BinaryPath+".previous"); got != "old agent" {
		t.Fatalf("previous binary is %q", got)
	}
	want := []string{"kry install-service", "systemctl restart krynodes.service"}
	if strings.Join(h.runs, "|") != strings.Join(want, "|") {
		t.Fatalf("ran %#v", h.runs)
	}
}

func TestApplyRefusesAReleaseThatFailsVerification(t *testing.T) {
	public, private := keys(t)
	_, stranger := keys(t)
	good := signedRelease(t, private, []byte("new agent"))

	tampered := good
	tampered.binary = []byte("evil agent")
	foreignKey := signedRelease(t, stranger, []byte("new agent"))
	wrongSum := good
	wrongSum.checksum = strings.Repeat("0", 64) + "  krynodes-linux-amd64\n"

	for name, published := range map[string]release{
		"tampered binary": tampered,
		"foreign key":     foreignKey,
		"wrong checksum":  wrongSum,
	} {
		t.Run(name, func(t *testing.T) {
			h := newHarness(t, public, published)
			if err := Apply(h.options); err == nil {
				t.Fatal("expected a refusal")
			}
			if got := contentOf(t, h.options.BinaryPath); got != "old agent" {
				t.Fatalf("binary was replaced with %q", got)
			}
			if len(h.runs) != 0 {
				t.Fatalf("ran %#v", h.runs)
			}
		})
	}
}

func TestApplyRefusesDowngradesAndUnknownArchitectures(t *testing.T) {
	public, private := keys(t)
	published := signedRelease(t, private, []byte("new agent"))

	same := newHarness(t, public, published)
	same.options.CurrentVersion = "0.5.2"
	if err := Apply(same.options); err == nil {
		t.Fatal("reinstalled the running version")
	}

	older := newHarness(t, public, published)
	older.options.CurrentVersion = "0.6.0"
	if err := Apply(older.options); err == nil {
		t.Fatal("downgraded the agent")
	}

	arch := newHarness(t, public, published)
	arch.options.Arch = "mips"
	if err := Apply(arch.options); err == nil {
		t.Fatal("accepted an unknown architecture")
	}
}

func TestTheEmbeddedReleaseKeyIsUsable(t *testing.T) {
	key, err := PublicKey()
	if err != nil || len(key) != ed25519.PublicKeySize {
		t.Fatalf("release key: %v (%d bytes)", err, len(key))
	}
}
