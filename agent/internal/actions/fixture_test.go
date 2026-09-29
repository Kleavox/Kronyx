package actions

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

type browserFixture struct {
	Origin string     `json:"origin"`
	RPID   string     `json:"rpId"`
	NodeID string     `json:"nodeId"`
	Now    string     `json:"now"`
	Keys   []TrustKey `json:"keys"`
	First  Request    `json:"first"`
	Change Request    `json:"change"`
	Deploy Request    `json:"deploy"`
}

func loadBrowserFixture(t *testing.T) browserFixture {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "packages", "protocol", "src", "fixtures", "deploy-signed.json"))
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var fixture browserFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatalf("decode fixture: %v", err)
	}
	return fixture
}

func issuedAt(t *testing.T, request Request) time.Time {
	t.Helper()
	var signed signedTrust
	if err := json.Unmarshal(request.Signed, &signed); err != nil {
		t.Fatal(err)
	}
	raw, err := b64.DecodeString(signed.Change)
	if err != nil {
		t.Fatal(err)
	}
	var change trustChange
	if err := json.Unmarshal(raw, &change); err != nil {
		t.Fatal(err)
	}
	at, err := time.Parse(time.RFC3339Nano, change.IssuedAt)
	if err != nil {
		t.Fatal(err)
	}
	return at.Add(time.Second)
}

func browserTrust(t *testing.T, fixture browserFixture) Trust {
	t.Helper()
	first, err := ApplyTrustChange(Trust{}, fixture.First, issuedAt(t, fixture.First))
	if err != nil {
		t.Fatalf("first trust: %v", err)
	}
	changed, err := ApplyTrustChange(first, fixture.Change, issuedAt(t, fixture.Change))
	if err != nil {
		t.Fatalf("trust change: %v", err)
	}
	return changed
}

func TestTheBrowsersFirstTrustApplies(t *testing.T) {
	fixture := loadBrowserFixture(t)
	trust, err := ApplyTrustChange(Trust{}, fixture.First, issuedAt(t, fixture.First))
	if err != nil {
		t.Fatal(err)
	}
	if trust.NodeID != fixture.NodeID || trust.Origin != fixture.Origin || trust.RPID != fixture.RPID || len(trust.Keys) != 1 {
		t.Fatalf("trust %+v", trust)
	}
}

func TestTheBrowsersTrustChangeApplies(t *testing.T) {
	fixture := loadBrowserFixture(t)
	trust := browserTrust(t, fixture)
	if trust.Version != 2 || len(trust.Keys) != 2 || trust.NodeID != fixture.NodeID {
		t.Fatalf("trust %+v", trust)
	}
}

func TestTheBrowsersDeployCommandVerifies(t *testing.T) {
	fixture := loadBrowserFixture(t)
	now, err := time.Parse(time.RFC3339Nano, fixture.Now)
	if err != nil {
		t.Fatal(err)
	}
	command, err := VerifyCommand(browserTrust(t, fixture), fixture.Deploy, now)
	if err != nil {
		t.Fatal(err)
	}
	if command.Name != "listmonk" || command.Action != "deploy" || command.NodeID != fixture.NodeID {
		t.Fatalf("command %+v", command)
	}
}

func TestTheBrowsersCommandIsRefusedForAnotherOrigin(t *testing.T) {
	fixture := loadBrowserFixture(t)
	now, err := time.Parse(time.RFC3339Nano, fixture.Now)
	if err != nil {
		t.Fatal(err)
	}
	trust := browserTrust(t, fixture)
	trust.Origin = "https://kry.kleavox.xyz"
	_, err = VerifyCommand(trust, fixture.Deploy, now)
	refused(t, err, "origin does not match")
}
