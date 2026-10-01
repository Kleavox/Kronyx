package actions

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func requireUvCase(core []TrustKey, access []string) *changeCase {
	c := newChange(2, core, map[string][]string{testNode: access})
	c.body["requireUv"] = true
	return c
}

func TestTurningOnFingerprintsRemovesTouchOnlyDevicesAndDropsThePassphrase(t *testing.T) {
	found := devices(t, "a", "b")
	pass, private := passphraseKey(t)
	current := storeOf(found, []string{"a", "b"}, []string{"a", "b"})
	current.Passphrase = &pass
	c := requireUvCase(keysOf(found, "b"), []string{"b"}).by(found, "a", "b")
	c.approvals[0].flags = flagPresent
	c.approvals[0].passphrase = private
	next, err := apply(t, current, c)
	if err != nil {
		t.Fatal(err)
	}
	if !next.RequireUV || next.Passphrase != nil || len(next.Core) != 1 || next.Core[0].ID != "b" {
		t.Fatalf("next %+v", next)
	}
	if report := next.Report(); !report.RequireUV || report.Passphrase {
		t.Fatalf("report %+v", report)
	}
}

func TestTurningOnFingerprintsWhileATouchOnlyDeviceStaysIsRefused(t *testing.T) {
	found := devices(t, "a", "b")
	current := storeOf(found, []string{"a", "b"}, []string{"a", "b"})
	c := requireUvCase(nil, []string{"a", "b"}).by(found, "a", "b")
	c.approvals[0].flags = flagPresent
	_, err := apply(t, current, c)
	refused(t, err, "must approve with a fingerprint")
}

func TestTurningOnFingerprintsNeedsTwoCoreDevices(t *testing.T) {
	found := devices(t, "a", "b")
	current := storeOf(found, []string{"a", "b"}, []string{"a", "b"})
	_, err := apply(t, current, requireUvCase(nil, []string{"a", "b"}).by(found, "b"))
	refused(t, err, "needs 1 more core device")
}

func TestOnceFingerprintsAreRequiredATouchIsRefusedEvenWithThePassphrase(t *testing.T) {
	found := devices(t, "a", "b")
	pass, private := passphraseKey(t)
	current := storeOf(found, []string{"a", "b"}, []string{"a", "b"})
	current.Passphrase = &pass
	current.RequireUV = true
	c := newChange(2, nil, map[string][]string{testNode: {"a"}}).by(found, "a")
	c.approvals[0].flags = flagPresent
	c.approvals[0].passphrase = private
	_, err := apply(t, current, c)
	refused(t, err, "did not verify a fingerprint")
}

func TestOnceFingerprintsAreRequiredAPassphraseIsRefused(t *testing.T) {
	found := devices(t, "a", "b")
	pass, _ := passphraseKey(t)
	current := storeOf(found, []string{"a", "b"}, []string{"a", "b"})
	current.RequireUV = true
	c := newChange(2, nil, map[string][]string{testNode: {"a", "b"}}).by(found, "a", "b")
	c.body["passphrase"] = pass
	_, err := apply(t, current, c)
	refused(t, err, "no passphrase")

	c = requireUvCase(nil, []string{"a", "b"}).by(found, "a", "b")
	c.body["passphrase"] = pass
	_, err = apply(t, storeOf(found, []string{"a", "b"}, []string{"a", "b"}), c)
	refused(t, err, "no passphrase")
}

func TestTheFingerprintRuleCannotBeTurnedOff(t *testing.T) {
	found := devices(t, "a", "b")
	current := storeOf(found, []string{"a", "b"}, []string{"a", "b"})
	current.RequireUV = true
	c := newChange(2, nil, map[string][]string{testNode: {"a", "b"}}).by(found, "a", "b")
	c.body["requireUv"] = false
	_, err := apply(t, current, c)
	refused(t, err, "malformed")

	next, err := apply(t, current, newChange(2, nil, map[string][]string{testNode: {"a", "b"}}).by(found, "a"))
	if err != nil || !next.RequireUV {
		t.Fatalf("an ordinary change keeps the rule: %+v %v", next, err)
	}
}

func TestAFirstTrustCarriesTheFingerprintRule(t *testing.T) {
	found := devices(t, "a")
	c := requireUvCase(keysOf(found, "a"), []string{"a"})
	c.body["version"] = 1
	next, err := apply(t, Trust{}, c)
	if err != nil || !next.RequireUV {
		t.Fatalf("next %+v err %v", next, err)
	}
}

func TestOnceFingerprintsAreRequiredATouchOnlyGrantIsRefused(t *testing.T) {
	c := newDeployCase(t, algES256)
	c.trust.RequireUV = true
	if err := c.verify(t, testNow); err != nil {
		t.Fatal(err)
	}
	c.assertion.flags = flagPresent
	refused(t, c.verify(t, testNow), "did not verify a fingerprint")
}

func TestTheFingerprintRuleRoundTripsThroughTheStateDirectory(t *testing.T) {
	dir := t.TempDir()
	found := devices(t, "a")
	current := storeOf(found, []string{"a"}, []string{"a"})
	current.RequireUV = true
	if err := SaveTrust(dir, current); err != nil {
		t.Fatal(err)
	}
	loaded, err := LoadTrust(dir)
	if err != nil || !loaded.RequireUV {
		t.Fatalf("loaded %+v err %v", loaded, err)
	}
}

type browserUVFixture struct {
	NodeID string  `json:"nodeId"`
	Now    string  `json:"now"`
	First  Request `json:"first"`
	Admit  Request `json:"admit"`
	Enable Request `json:"enable"`
	Deploy Request `json:"deploy"`
}

func loadBrowserUVFixture(t *testing.T) browserUVFixture {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "packages", "protocol", "src", "fixtures", "browser-uv.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture browserUVFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	return fixture
}

func TestTheBrowsersFingerprintRuleAppliesAndItsDeployVerifies(t *testing.T) {
	fixture := loadBrowserUVFixture(t)
	trust := Trust{}
	for _, request := range []Request{fixture.First, fixture.Admit} {
		next, err := ApplyTrustChange(trust, request, issuedAt(t, request))
		if err != nil {
			t.Fatal(err)
		}
		trust = next
	}
	strict := trust
	strict.RequireUV = true
	_, err := ApplyTrustChange(strict, fixture.Enable, issuedAt(t, fixture.Enable))
	refused(t, err, "did not verify a fingerprint")

	ruled, err := ApplyTrustChange(trust, fixture.Enable, issuedAt(t, fixture.Enable))
	if err != nil {
		t.Fatal(err)
	}
	if !ruled.RequireUV || len(ruled.Core) != 1 || len(ruled.Access) != 1 || ruled.NodeID != fixture.NodeID {
		t.Fatalf("ruled %+v", ruled)
	}
	now, err := time.Parse(time.RFC3339Nano, fixture.Now)
	if err != nil {
		t.Fatal(err)
	}
	command, err := VerifyCommand(ruled, fixture.Deploy, now)
	if err != nil || command.Name != "listmonk" {
		t.Fatalf("command %+v err %v", command, err)
	}
}
