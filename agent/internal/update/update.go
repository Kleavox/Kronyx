package update

import (
	"crypto/ed25519"
	"crypto/sha256"
	_ "embed"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
)

const (
	RequestPath = "/var/lib/kry/update-request"
	DefaultBase = "https://github.com/Kleavox/Krynodes/releases/download"
	maxDownload = 64 << 20
)

//go:embed release.pub
var releaseKey string

var versionPattern = regexp.MustCompile(`^\d+\.\d+\.\d+$`)

type Options struct {
	RequestPath    string
	BinaryPath     string
	Base           string
	Arch           string
	CurrentVersion string
	PublicKey      ed25519.PublicKey
	Client         *http.Client
	Run            func(name string, args ...string) error
}

func PublicKey() (ed25519.PublicKey, error) {
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(releaseKey))
	if err != nil {
		return nil, fmt.Errorf("decode release key: %w", err)
	}
	if len(raw) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("release key has %d bytes", len(raw))
	}
	return ed25519.PublicKey(raw), nil
}

func WriteRequest(path, version, requestedAt string) (bool, error) {
	if !versionPattern.MatchString(version) {
		return false, fmt.Errorf("invalid version %q", version)
	}
	content := version + "\n" + requestedAt + "\n"
	if existing, err := os.ReadFile(path); err == nil && string(existing) == content {
		return false, nil
	}
	temporary := path + ".tmp"
	if err := os.WriteFile(temporary, []byte(content), 0o644); err != nil {
		return false, err
	}
	return true, os.Rename(temporary, path)
}

func Apply(options Options) error {
	raw, err := os.ReadFile(options.RequestPath)
	if err != nil {
		return fmt.Errorf("read update request: %w", err)
	}
	target, _, _ := strings.Cut(string(raw), "\n")
	target = strings.TrimSpace(target)
	if !versionPattern.MatchString(target) {
		return fmt.Errorf("invalid version %q", target)
	}
	newer, err := isNewer(target, options.CurrentVersion)
	if err != nil {
		return err
	}
	if !newer {
		return fmt.Errorf("refusing %s: the running agent is %s", target, options.CurrentVersion)
	}
	if options.Arch != "amd64" && options.Arch != "arm64" {
		return fmt.Errorf("unsupported architecture %q", options.Arch)
	}

	artifact := "krynodes-linux-" + options.Arch
	url := fmt.Sprintf("%s/agent-v%s/%s", strings.TrimRight(options.Base, "/"), target, artifact)
	binary, err := download(options.Client, url)
	if err != nil {
		return err
	}
	checksum, err := download(options.Client, url+".sha256")
	if err != nil {
		return err
	}
	signature, err := download(options.Client, url+".sig")
	if err != nil {
		return err
	}
	if err := verify(binary, checksum, signature, options.PublicKey); err != nil {
		return err
	}
	return install(options, binary)
}

func verify(binary, checksum, signature []byte, key ed25519.PublicKey) error {
	fields := strings.Fields(string(checksum))
	sum := sha256.Sum256(binary)
	if len(fields) == 0 || !strings.EqualFold(fields[0], hex.EncodeToString(sum[:])) {
		return errors.New("checksum does not match the downloaded binary")
	}
	if len(key) != ed25519.PublicKeySize || !ed25519.Verify(key, binary, signature) {
		return errors.New("signature does not match the release key")
	}
	return nil
}

func install(options Options, binary []byte) error {
	current := options.BinaryPath
	staged := current + ".new"
	previous := current + ".previous"
	if err := os.WriteFile(staged, binary, 0o755); err != nil {
		return fmt.Errorf("stage new binary: %w", err)
	}
	if err := os.Rename(current, previous); err != nil {
		return fmt.Errorf("keep previous binary: %w", err)
	}
	if err := os.Rename(staged, current); err != nil {
		_ = os.Rename(previous, current)
		return fmt.Errorf("install new binary: %w", err)
	}
	if err := options.Run(current, "install-service"); err != nil {
		return fmt.Errorf("refresh service units: %w", err)
	}
	return options.Run("systemctl", "restart", "krynodes.service")
}

func download(client *http.Client, url string) ([]byte, error) {
	response, err := client.Get(url)
	if err != nil {
		return nil, fmt.Errorf("download %s: %w", url, err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("download %s: HTTP %d", url, response.StatusCode)
	}
	return io.ReadAll(io.LimitReader(response.Body, maxDownload))
}

func isNewer(target, current string) (bool, error) {
	if !versionPattern.MatchString(current) {
		return false, fmt.Errorf("the running agent has no release version (%q)", current)
	}
	left := strings.Split(target, ".")
	right := strings.Split(current, ".")
	for index := range left {
		a, _ := strconv.Atoi(left[index])
		b, _ := strconv.Atoi(right[index])
		if a != b {
			return a > b, nil
		}
	}
	return false, nil
}
