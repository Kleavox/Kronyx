package actions

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

const otherNode = "44444444-4444-4444-8444-444444444444"

type changeCase struct {
	body      map[string]any
	passkey   crypto.Signer
	id        string
	assertion assertionOptions
	unsigned  bool
}

func newChange(t *testing.T, version int, keys ...TrustKey) *changeCase {
	t.Helper()
	return &changeCase{
		body: map[string]any{
			"v": 1, "nodeIds": []string{testNode}, "origin": testOrigin, "rpId": testRPID,
			"version": version, "keys": keys,
			"issuedAt": testNow.Format(time.RFC3339Nano), "expiresAt": testNow.Add(10 * time.Minute).Format(time.RFC3339Nano),
		},
		assertion: assertionOptions{origin: testOrigin, rpID: testRPID, clientType: "webauthn.get", flags: flagPresent | flagVerified},
	}
}

func (c *changeCase) request(t *testing.T) Request {
	t.Helper()
	changeBytes, err := json.Marshal(c.body)
	if err != nil {
		t.Fatal(err)
	}
	signed := map[string]any{"change": b64.EncodeToString(changeBytes), "assertion": nil}
	if !c.unsigned {
		options := c.assertion
		options.challenge = digest(changeBytes)
		signed["assertion"] = sign(t, c.passkey, c.id, options)
	}
	raw, err := json.Marshal(signed)
	if err != nil {
		t.Fatal(err)
	}
	return Request{ID: testID, Kind: "trust", Name: "devices", Action: "trust", ExpiresAt: testNow.Add(10 * time.Minute).Format(time.RFC3339Nano), Signed: raw}
}

func trusted(t *testing.T) (Trust, TrustKey, crypto.Signer) {
	t.Helper()
	key, passkey := newPasskey(t, "cred-1", algES256)
	return Trust{NodeID: testNode, Origin: testOrigin, RPID: testRPID, Version: 1, Keys: []TrustKey{key}}, key, passkey
}

func TestTheFirstTrustIsAcceptedUnsignedOnAnEmptyStore(t *testing.T) {
	key, _ := newPasskey(t, "cred-1", algES256)
	c := newChange(t, 1, key)
	c.unsigned = true
	next, err := ApplyTrustChange(Trust{}, c.request(t), testNow)
	if err != nil {
		t.Fatal(err)
	}
	if next.NodeID != testNode || next.Origin != testOrigin || next.RPID != testRPID || next.Version != 1 || len(next.Keys) != 1 {
		t.Fatalf("trust %+v", next)
	}
}

func TestAnUnsignedFirstTrustForSeveralServersIsRefused(t *testing.T) {
	key, _ := newPasskey(t, "cred-1", algES256)
	c := newChange(t, 1, key)
	c.unsigned = true
	c.body["nodeIds"] = []string{testNode, otherNode}
	_, err := ApplyTrustChange(Trust{}, c.request(t), testNow)
	refused(t, err, "exactly one server")
}

func TestAnUnsignedChangeIsRefusedOnceAKeyIsTrusted(t *testing.T) {
	current, key, _ := trusted(t)
	c := newChange(t, 2, key)
	c.unsigned = true
	_, err := ApplyTrustChange(current, c.request(t), testNow)
	refused(t, err, "must be signed")
}

func TestASignedChangeWithAHigherVersionReplacesTheKeys(t *testing.T) {
	current, key, passkey := trusted(t)
	phone, _ := newPasskey(t, "cred-2", algES256)
	c := newChange(t, 2, key, phone)
	c.passkey, c.id = passkey, "cred-1"
	next, err := ApplyTrustChange(current, c.request(t), testNow)
	if err != nil {
		t.Fatal(err)
	}
	if next.NodeID != testNode || next.Version != 2 || len(next.Keys) != 2 {
		t.Fatalf("trust %+v", next)
	}
}

func TestAStaleVersionIsRefused(t *testing.T) {
	current, key, passkey := trusted(t)
	c := newChange(t, 1, key)
	c.passkey, c.id = passkey, "cred-1"
	_, err := ApplyTrustChange(current, c.request(t), testNow)
	refused(t, err, "version")
}

func TestAChangeForOtherServersIsRefused(t *testing.T) {
	current, key, passkey := trusted(t)
	c := newChange(t, 2, key)
	c.passkey, c.id = passkey, "cred-1"
	c.body["nodeIds"] = []string{otherNode}
	_, err := ApplyTrustChange(current, c.request(t), testNow)
	refused(t, err, "not for this server")
}

func TestAnotherOriginIsRefused(t *testing.T) {
	current, key, passkey := trusted(t)
	c := newChange(t, 2, key)
	c.passkey, c.id = passkey, "cred-1"
	c.body["origin"] = "https://evil.example"
	c.body["rpId"] = "evil.example"
	_, err := ApplyTrustChange(current, c.request(t), testNow)
	refused(t, err, "another origin")
}

func TestARPIDThatIsNotTheOriginHostIsRefused(t *testing.T) {
	key, _ := newPasskey(t, "cred-1", algES256)
	c := newChange(t, 1, key)
	c.unsigned = true
	c.body["rpId"] = "kleavox.xyz"
	_, err := ApplyTrustChange(Trust{}, c.request(t), testNow)
	refused(t, err, "host of the origin")
}

func TestAnEmptyKeyListIsRefused(t *testing.T) {
	current, _, passkey := trusted(t)
	c := newChange(t, 2)
	c.passkey, c.id = passkey, "cred-1"
	c.body["keys"] = []TrustKey{}
	_, err := ApplyTrustChange(current, c.request(t), testNow)
	refused(t, err, "at least one")
}

func TestAWeakRSAKeyIsRefused(t *testing.T) {
	private, err := rsa.GenerateKey(rand.Reader, 1024)
	if err != nil {
		t.Fatal(err)
	}
	weak := TrustKey{ID: "cred-9", Name: "Old", Alg: algRS256, PublicKey: spki(t, &private.PublicKey)}
	c := newChange(t, 1, weak)
	c.unsigned = true
	_, err = ApplyTrustChange(Trust{}, c.request(t), testNow)
	refused(t, err, "at least 2048 bits")
}

func TestAChangeSignedByAnUntrustedPasskeyIsRefused(t *testing.T) {
	current, key, _ := trusted(t)
	_, stranger := newPasskey(t, "cred-7", algES256)
	c := newChange(t, 2, key)
	c.passkey, c.id = stranger, "cred-7"
	_, err := ApplyTrustChange(current, c.request(t), testNow)
	refused(t, err, "passkey is not trusted")
}

func TestAnExpiredChangeIsRefused(t *testing.T) {
	current, key, passkey := trusted(t)
	c := newChange(t, 2, key)
	c.passkey, c.id = passkey, "cred-1"
	_, err := ApplyTrustChange(current, c.request(t), testNow.Add(12*time.Minute))
	refused(t, err, "expired")
}

func TestAChangeLongerThanTenMinutesIsRefused(t *testing.T) {
	current, key, passkey := trusted(t)
	c := newChange(t, 2, key)
	c.passkey, c.id = passkey, "cred-1"
	c.body["expiresAt"] = testNow.Add(11 * time.Minute).Format(time.RFC3339Nano)
	_, err := ApplyTrustChange(current, c.request(t), testNow)
	refused(t, err, "10 minutes")
}

func TestTrustRoundTripsThroughTheStateDirectory(t *testing.T) {
	dir := t.TempDir()
	empty, err := LoadTrust(dir)
	if err != nil || len(empty.Keys) != 0 {
		t.Fatalf("empty %+v err %v", empty, err)
	}
	current, _, _ := trusted(t)
	if err := SaveTrust(dir, current); err != nil {
		t.Fatal(err)
	}
	loaded, err := LoadTrust(dir)
	if err != nil || loaded.NodeID != testNode || len(loaded.Keys) != 1 {
		t.Fatalf("loaded %+v err %v", loaded, err)
	}
	info, err := os.Stat(filepath.Join(dir, "trust.json"))
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v", info.Mode().Perm())
	}
}

func TestTheTrustReportCarriesFingerprints(t *testing.T) {
	current, key, _ := trusted(t)
	report := current.Report()
	if report.Version != 1 || len(report.Keys) != 1 || report.Keys[0] != Fingerprint(key) || len(report.Keys[0]) != 16 {
		t.Fatalf("report %+v", report)
	}
}

func TestParseTrustArgsReadsIDAlgAndKey(t *testing.T) {
	key, _ := newPasskey(t, "cred-1", algES256)
	trust, err := ParseTrustArgs(testOrigin, []string{"cred-1.-7." + key.PublicKey})
	if err != nil {
		t.Fatal(err)
	}
	if trust.Origin != testOrigin || trust.RPID != testRPID || trust.Version != 1 || len(trust.Keys) != 1 || trust.Keys[0].ID != "cred-1" || trust.Keys[0].Alg != algES256 {
		t.Fatalf("trust %+v", trust)
	}
	for _, bad := range [][]string{{"cred-1"}, {"cred-1.x." + key.PublicKey}, {"cred-1.5." + key.PublicKey}, {"cred-1.-7.bm90YWtleQ"}, {}} {
		if _, err := ParseTrustArgs(testOrigin, bad); err == nil {
			t.Errorf("%v should be refused", bad)
		}
	}
	if _, err := ParseTrustArgs("kry.kleavox.xyz", []string{"cred-1.-7." + key.PublicKey}); err == nil {
		t.Error("an origin without a scheme should be refused")
	}
}

func TestTheExecutorAppliesATrustRequestAndReportsIt(t *testing.T) {
	executor, run := newExecutor(t)
	executor.Now = func() time.Time { return testNow }
	key, _ := newPasskey(t, "cred-1", algES256)
	c := newChange(t, 1, key)
	c.unsigned = true
	request := c.request(t)
	writeRequest(t, executor.RequestDir, testID+".json", request)
	if err := executor.Execute(context.Background()); err != nil {
		t.Fatal(err)
	}
	if result := readResult(t, executor, testID); !result.OK {
		t.Fatalf("result %+v", result)
	}
	stored, err := LoadTrust(executor.StateDir)
	if err != nil || stored.NodeID != testNode {
		t.Fatalf("stored %+v err %v", stored, err)
	}
	var inventory Inventory
	if err := readJSON(filepath.Join(executor.StateDir, "inventory.json"), &inventory); err != nil {
		t.Fatal(err)
	}
	if inventory.Trust.Version != 1 || len(inventory.Trust.Keys) != 1 {
		t.Fatalf("inventory trust %+v", inventory.Trust)
	}
	if len(run.calls) != 0 {
		t.Fatalf("calls %#v", run.calls)
	}
}
