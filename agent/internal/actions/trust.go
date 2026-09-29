package actions

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/Kleavox/krynodes/agent/internal/reporter"
)

const (
	trustChangeLimit = 10 * time.Minute
	maxTrustedKeys   = 20
)

var credentialID = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

type trustChange struct {
	V         int        `json:"v"`
	NodeIDs   []string   `json:"nodeIds"`
	Origin    string     `json:"origin"`
	RPID      string     `json:"rpId"`
	Version   int        `json:"version"`
	Keys      []TrustKey `json:"keys"`
	IssuedAt  string     `json:"issuedAt"`
	ExpiresAt string     `json:"expiresAt"`
}

type signedTrust struct {
	Change    string     `json:"change"`
	Assertion *Assertion `json:"assertion"`
}

func LoadTrust(stateDir string) (Trust, error) {
	raw, err := os.ReadFile(filepath.Join(stateDir, "trust.json"))
	if errors.Is(err, os.ErrNotExist) {
		return Trust{}, nil
	}
	if err != nil {
		return Trust{}, err
	}
	var trust Trust
	if err := strict(raw, &trust); err != nil {
		return Trust{}, errors.New("the trust store is unreadable; reset it with kry trust --reset")
	}
	return trust, nil
}

func SaveTrust(stateDir string, trust Trust) error {
	return writeJSON(stateDir, "trust.json", trust, 0o600)
}

func (t Trust) Report() reporter.TrustReport {
	keys := make([]string, 0, len(t.Keys))
	for _, key := range t.Keys {
		keys = append(keys, Fingerprint(key))
	}
	return reporter.TrustReport{Version: t.Version, Keys: keys}
}

func originHost(origin string) (string, error) {
	parsed, err := url.Parse(origin)
	if err != nil || (parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.Host == "" || parsed.Path != "" || parsed.RawQuery != "" || parsed.User != nil {
		return "", fmt.Errorf("%q is not an origin", origin)
	}
	return parsed.Hostname(), nil
}

func checkKeys(keys []TrustKey) error {
	if len(keys) == 0 {
		return errors.New("a change needs at least one device")
	}
	if len(keys) > maxTrustedKeys {
		return errors.New("too many devices")
	}
	for _, key := range keys {
		if len(key.ID) > 1400 || !credentialID.MatchString(key.ID) {
			return errors.New("a device id is not base64url")
		}
		if _, err := parseKey(key); err != nil {
			return err
		}
	}
	return nil
}

func ApplyTrustChange(current Trust, request Request, now time.Time) (Trust, error) {
	var signed signedTrust
	if err := strict(request.Signed, &signed); err != nil {
		return Trust{}, fmt.Errorf("the change is malformed: %w", err)
	}
	changeBytes, err := decode("change", signed.Change)
	if err != nil {
		return Trust{}, err
	}
	var change trustChange
	if err := strict(changeBytes, &change); err != nil || change.V != 1 || change.Version < 1 {
		return Trust{}, errors.New("the change is malformed")
	}
	issued, err := stamp("change issuedAt", change.IssuedAt)
	if err != nil {
		return Trust{}, err
	}
	expires, err := stamp("change expiresAt", change.ExpiresAt)
	if err != nil {
		return Trust{}, err
	}
	if !expires.After(issued) || expires.Sub(issued) > trustChangeLimit {
		return Trust{}, errors.New("the change lasts longer than 10 minutes")
	}
	if now.After(expires.Add(clockSkew)) {
		return Trust{}, errors.New("the change expired")
	}
	host, err := originHost(change.Origin)
	if err != nil {
		return Trust{}, err
	}
	if change.RPID != host {
		return Trust{}, errors.New("the rp id is not the host of the origin")
	}
	if err := checkKeys(change.Keys); err != nil {
		return Trust{}, err
	}
	if len(current.Keys) == 0 {
		if signed.Assertion != nil {
			return Trust{}, errors.New("no device is trusted yet")
		}
		if len(change.NodeIDs) != 1 {
			return Trust{}, errors.New("a first trust must name exactly one server")
		}
		return Trust{NodeID: change.NodeIDs[0], Origin: change.Origin, RPID: change.RPID, Version: change.Version, Keys: change.Keys}, nil
	}
	if signed.Assertion == nil {
		return Trust{}, errors.New("the change must be signed by a trusted device")
	}
	if err := verifyAssertion(current, *signed.Assertion, digest(changeBytes)); err != nil {
		return Trust{}, err
	}
	if change.Version <= current.Version {
		return Trust{}, errors.New("the version is not newer than the stored one")
	}
	if change.Origin != current.Origin || change.RPID != current.RPID {
		return Trust{}, errors.New("the change is for another origin")
	}
	if !slices.Contains(change.NodeIDs, current.NodeID) {
		return Trust{}, errors.New("the change is not for this server")
	}
	return Trust{NodeID: current.NodeID, Origin: current.Origin, RPID: current.RPID, Version: change.Version, Keys: change.Keys}, nil
}

func ParseTrustArgs(origin string, tokens []string) (Trust, error) {
	host, err := originHost(origin)
	if err != nil {
		return Trust{}, err
	}
	keys := make([]TrustKey, 0, len(tokens))
	for _, token := range tokens {
		parts := strings.SplitN(token, ".", 3)
		if len(parts) != 3 {
			return Trust{}, fmt.Errorf("%q is not <id>.<alg>.<key>", token)
		}
		alg, err := strconv.Atoi(parts[1])
		if err != nil {
			return Trust{}, fmt.Errorf("%q has no algorithm number", token)
		}
		keys = append(keys, TrustKey{ID: parts[0], Alg: alg, PublicKey: parts[2]})
	}
	if err := checkKeys(keys); err != nil {
		return Trust{}, err
	}
	return Trust{Origin: origin, RPID: host, Version: 1, Keys: keys}, nil
}
