package actions

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

const (
	idA = "0b4f4f53-7d1c-4b55-9a39-2f0a0d6c1a01"
	idB = "0b4f4f53-7d1c-4b55-9a39-2f0a0d6c1a02"
)

var executorNow = time.Date(2026, 9, 29, 10, 0, 0, 0, time.UTC)

type fakeRun struct {
	calls   []string
	output  string
	code    int
	err     error
	during  func()
	respond map[string]string
}

func (f *fakeRun) run(_ context.Context, name string, args ...string) ([]byte, int, error) {
	call := name + " " + strings.Join(args, " ")
	f.calls = append(f.calls, call)
	if answer, ok := f.respond[call]; ok {
		return []byte(answer), 0, nil
	}
	if f.during != nil {
		during := f.during
		f.during = nil
		during()
	}
	return []byte(f.output), f.code, f.err
}

func newExecutor(t *testing.T) (Executor, *fakeRun) {
	t.Helper()
	base := t.TempDir()
	requests := filepath.Join(base, "actions")
	if err := os.MkdirAll(requests, 0o750); err != nil {
		t.Fatal(err)
	}
	run := &fakeRun{}
	services := []Service{{Kind: "docker", Name: "adguard", State: "running"}, {Kind: "systemd", Name: "nginx.service", State: "running"}}
	return Executor{
		RequestDir: requests,
		StateDir:   filepath.Join(base, "exec"),
		Now:        func() time.Time { return executorNow },
		Run:        run.run,
		Collect:    func(context.Context, []string) ([]Service, error) { return services, nil },
	}, run
}

func writeRequest(t *testing.T, dir, file string, body any) {
	t.Helper()
	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, file), encoded, 0o640); err != nil {
		t.Fatal(err)
	}
}

func request(id, kind, name, action string, expires time.Time) Request {
	return Request{ID: id, Kind: kind, Name: name, Action: action, ExpiresAt: expires.Format(time.RFC3339Nano)}
}

func readResult(t *testing.T, executor Executor, id string) Result {
	t.Helper()
	var result Result
	if err := readJSON(filepath.Join(executor.StateDir, "results", id+".json"), &result); err != nil {
		t.Fatalf("read result %s: %v", id, err)
	}
	return result
}

func TestARestartRunsWithExactArgumentsAndReportsSuccess(t *testing.T) {
	executor, run := newExecutor(t)
	writeRequest(t, executor.RequestDir, idA+".json", request(idA, "docker", "adguard", "restart", executorNow.Add(10*time.Minute)))
	if err := executor.Execute(context.Background()); err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !slices.Equal(run.calls, []string{"docker restart -- adguard"}) {
		t.Fatalf("unexpected calls %#v", run.calls)
	}
	result := readResult(t, executor, idA)
	if !result.OK || result.ExitCode == nil || *result.ExitCode != 0 || result.FinishedAt != "2026-09-29T10:00:00Z" {
		t.Fatalf("unexpected result %#v", result)
	}
	var inventory Inventory
	if err := readJSON(filepath.Join(executor.StateDir, "inventory.json"), &inventory); err != nil || len(inventory.Services) != 2 {
		t.Fatalf("inventory %#v err %v", inventory, err)
	}
}

func TestRefusalsRunNothingAndSayWhy(t *testing.T) {
	cases := map[string]Request{
		"protected": request(idA, "systemd", "ssh.service", "restart", executorNow.Add(time.Minute)),
		"not here":  request(idA, "docker", "ghost", "restart", executorNow.Add(time.Minute)),
		"expired":   request(idA, "docker", "adguard", "restart", executorNow.Add(-2*time.Minute)),
		"action":    request(idA, "docker", "adguard", "exec", executorNow.Add(time.Minute)),
		"name":      request(idA, "docker", "-rm", "restart", executorNow.Add(time.Minute)),
		"other id":  request(idB, "docker", "adguard", "restart", executorNow.Add(time.Minute)),
	}
	for label, body := range cases {
		t.Run(label, func(t *testing.T) {
			executor, run := newExecutor(t)
			writeRequest(t, executor.RequestDir, idA+".json", body)
			if err := executor.Execute(context.Background()); err != nil {
				t.Fatalf("execute: %v", err)
			}
			result := readResult(t, executor, idA)
			if len(run.calls) != 0 || result.OK || result.ExitCode != nil || !strings.HasPrefix(result.Output, "refused: ") {
				t.Fatalf("calls %#v result %#v", run.calls, result)
			}
		})
	}
}

func TestAnExpiryWithinTheSkewStillRuns(t *testing.T) {
	executor, run := newExecutor(t)
	writeRequest(t, executor.RequestDir, idA+".json", request(idA, "docker", "adguard", "restart", executorNow.Add(-30*time.Second)))
	if err := executor.Execute(context.Background()); err != nil || len(run.calls) != 1 {
		t.Fatalf("calls %#v err %v", run.calls, err)
	}
}

func TestUnknownFieldsAreRefused(t *testing.T) {
	executor, run := newExecutor(t)
	writeRequest(t, executor.RequestDir, idA+".json", map[string]string{"id": idA, "kind": "docker", "name": "adguard", "action": "restart", "expiresAt": executorNow.Add(time.Minute).Format(time.RFC3339), "shell": "rm -rf /"})
	if err := executor.Execute(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(run.calls) != 0 || readResult(t, executor, idA).OK {
		t.Fatal("a request with unknown fields must be refused")
	}
}

func TestEachRequestRunsOnceAndIsRecordedFirst(t *testing.T) {
	executor, run := newExecutor(t)
	writeRequest(t, executor.RequestDir, idA+".json", request(idA, "docker", "adguard", "restart", executorNow.Add(time.Minute)))
	run.during = func() {
		raw, err := os.ReadFile(filepath.Join(executor.StateDir, "executed.json"))
		if err != nil || !strings.Contains(string(raw), idA) {
			t.Errorf("the ledger must hold the id before the command runs: %s %v", raw, err)
		}
	}
	for range 2 {
		if err := executor.Execute(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if len(run.calls) != 1 {
		t.Fatalf("expected one run, got %#v", run.calls)
	}
}

func TestARequestWrittenDuringARunIsNotLeftForTheTimer(t *testing.T) {
	executor, run := newExecutor(t)
	writeRequest(t, executor.RequestDir, idA+".json", request(idA, "docker", "adguard", "restart", executorNow.Add(time.Minute)))
	run.during = func() {
		writeRequest(t, executor.RequestDir, idB+".json", request(idB, "systemd", "nginx.service", "stop", executorNow.Add(time.Minute)))
	}
	if err := executor.Execute(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(run.calls, []string{"docker restart -- adguard", "systemctl stop -- nginx.service"}) {
		t.Fatalf("unexpected calls %#v", run.calls)
	}
}

func TestTheRequestDirectoryIsNeverWritten(t *testing.T) {
	executor, _ := newExecutor(t)
	writeRequest(t, executor.RequestDir, idA+".json", request(idA, "docker", "adguard", "restart", executorNow.Add(time.Minute)))
	for _, name := range []string{"refresh", ".x.tmp", "notes.json"} {
		if err := os.WriteFile(filepath.Join(executor.RequestDir, name), []byte("x"), 0o640); err != nil {
			t.Fatal(err)
		}
	}
	before, _ := os.ReadDir(executor.RequestDir)
	if err := executor.Execute(context.Background()); err != nil {
		t.Fatal(err)
	}
	after, _ := os.ReadDir(executor.RequestDir)
	if len(before) != len(after) {
		t.Fatalf("the request directory changed: %d -> %d entries", len(before), len(after))
	}
	if _, err := os.Stat(filepath.Join(executor.StateDir, "results", "notes.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("only id-named files are requests")
	}
}

func TestOversizedAndSymlinkedRequestsAreRefused(t *testing.T) {
	executor, run := newExecutor(t)
	if err := os.WriteFile(filepath.Join(executor.RequestDir, idA+".json"), []byte(strings.Repeat(" ", 5000)), 0o640); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "secret")
	writeRequest(t, filepath.Dir(outside), "secret", request(idB, "docker", "adguard", "restart", executorNow.Add(time.Minute)))
	symlinked := os.Symlink(outside, filepath.Join(executor.RequestDir, idB+".json")) == nil
	if err := executor.Execute(context.Background()); err != nil {
		t.Fatal(err)
	}
	if readResult(t, executor, idA).OK {
		t.Fatal("an oversized request must be refused")
	}
	if symlinked && readResult(t, executor, idB).OK {
		t.Fatal("a symlinked request must be refused")
	}
	if len(run.calls) != 0 {
		t.Fatalf("nothing may run, got %#v", run.calls)
	}
}

func TestASymlinkedRequestDirectoryIsIgnored(t *testing.T) {
	executor, run := newExecutor(t)
	elsewhere := t.TempDir()
	writeRequest(t, elsewhere, idA+".json", request(idA, "docker", "adguard", "restart", executorNow.Add(time.Minute)))
	if err := os.Remove(executor.RequestDir); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(elsewhere, executor.RequestDir); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if err := executor.Execute(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(run.calls) != 0 {
		t.Fatalf("a symlinked request directory must be ignored, got %#v", run.calls)
	}
}

func TestAUnitStoppedThroughKrynodesIsRememberedUntilItStartsAgain(t *testing.T) {
	executor, _ := newExecutor(t)
	var seen [][]string
	services := []Service{{Kind: "systemd", Name: "nginx.service", State: "running"}}
	executor.Collect = func(_ context.Context, remembered []string) ([]Service, error) {
		seen = append(seen, slices.Clone(remembered))
		return services, nil
	}
	writeRequest(t, executor.RequestDir, idA+".json", request(idA, "systemd", "nginx.service", "stop", executorNow.Add(time.Minute)))
	if err := executor.Execute(context.Background()); err != nil {
		t.Fatal(err)
	}
	if last := seen[len(seen)-1]; !slices.Equal(last, []string{"nginx.service"}) {
		t.Fatalf("after a stop the unit must be remembered, got %#v", last)
	}
	writeRequest(t, executor.RequestDir, idB+".json", request(idB, "systemd", "nginx.service", "start", executorNow.Add(time.Minute)))
	if err := executor.Execute(context.Background()); err != nil {
		t.Fatal(err)
	}
	if first, last := seen[len(seen)-2], seen[len(seen)-1]; !slices.Equal(first, []string{"nginx.service"}) || len(last) != 0 {
		t.Fatalf("the next run must start from the stored list and forget the unit once started, got %#v then %#v", first, last)
	}
}

func TestAFailedStopIsNotRemembered(t *testing.T) {
	executor, run := newExecutor(t)
	run.code, run.err = 1, errors.New("exit status 1")
	var last []string
	executor.Collect = func(_ context.Context, remembered []string) ([]Service, error) {
		last = remembered
		return []Service{{Kind: "systemd", Name: "nginx.service", State: "running"}}, nil
	}
	writeRequest(t, executor.RequestDir, idA+".json", request(idA, "systemd", "nginx.service", "stop", executorNow.Add(time.Minute)))
	if err := executor.Execute(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(last) != 0 {
		t.Fatalf("a failed stop must not be remembered, got %#v", last)
	}
}

func TestAFailedCommandKeepsItsExitCodeAndCleanOutput(t *testing.T) {
	executor, run := newExecutor(t)
	run.code, run.err = 1, errors.New("exit status 1")
	run.output = "Job for nginx.service failed.\r\n\x00" + strings.Repeat("x", 3000)
	writeRequest(t, executor.RequestDir, idA+".json", request(idA, "systemd", "nginx.service", "restart", executorNow.Add(time.Minute)))
	if err := executor.Execute(context.Background()); err != nil {
		t.Fatal(err)
	}
	result := readResult(t, executor, idA)
	if result.OK || result.ExitCode == nil || *result.ExitCode != 1 {
		t.Fatalf("unexpected result %#v", result)
	}
	if len(result.Output) != 2048 || strings.ContainsAny(result.Output, "\r\x00") || !strings.HasPrefix(result.Output, "Job for nginx.service failed.\n") {
		t.Fatalf("unexpected output %q...", result.Output[:40])
	}
}

func TestStartUnpausesAPausedContainer(t *testing.T) {
	executor, run := newExecutor(t)
	run.respond = map[string]string{"docker inspect --format {{.State.Paused}} -- adguard": "true\n"}
	writeRequest(t, executor.RequestDir, idA+".json", request(idA, "docker", "adguard", "start", executorNow.Add(time.Minute)))
	if err := executor.Execute(context.Background()); err != nil {
		t.Fatal(err)
	}
	want := []string{"docker inspect --format {{.State.Paused}} -- adguard", "docker unpause -- adguard"}
	if !slices.Equal(run.calls, want) {
		t.Fatalf("calls %#v", run.calls)
	}
}

func TestStartRunsDockerStartWhenNotPaused(t *testing.T) {
	executor, run := newExecutor(t)
	run.respond = map[string]string{"docker inspect --format {{.State.Paused}} -- adguard": "false\n"}
	writeRequest(t, executor.RequestDir, idA+".json", request(idA, "docker", "adguard", "start", executorNow.Add(time.Minute)))
	if err := executor.Execute(context.Background()); err != nil {
		t.Fatal(err)
	}
	if run.calls[len(run.calls)-1] != "docker start -- adguard" {
		t.Fatalf("calls %#v", run.calls)
	}
}

func TestACorruptLedgerIsSetAsideInsteadOfStoppingEveryRun(t *testing.T) {
	executor, run := newExecutor(t)
	if err := os.MkdirAll(executor.StateDir, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(executor.StateDir, "executed.json"), []byte("{\"trunc"), 0o600); err != nil {
		t.Fatal(err)
	}
	writeRequest(t, executor.RequestDir, idA+".json", request(idA, "docker", "adguard", "restart", executorNow.Add(time.Minute)))
	if err := executor.Execute(context.Background()); err != nil {
		t.Fatalf("execute: %v", err)
	}
	if len(run.calls) != 1 {
		t.Fatalf("calls %#v", run.calls)
	}
	if _, err := os.Stat(filepath.Join(executor.StateDir, "executed.json.corrupt")); err != nil {
		t.Fatal("the corrupt ledger must be kept aside")
	}
}

func TestACorruptStoppedListIsSetAsideInsteadOfStoppingEveryRun(t *testing.T) {
	executor, run := newExecutor(t)
	if err := os.MkdirAll(executor.StateDir, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(executor.StateDir, "stopped.json"), []byte("[\"trunc"), 0o640); err != nil {
		t.Fatal(err)
	}
	writeRequest(t, executor.RequestDir, idA+".json", request(idA, "docker", "adguard", "restart", executorNow.Add(time.Minute)))
	if err := executor.Execute(context.Background()); err != nil {
		t.Fatalf("execute: %v", err)
	}
	if len(run.calls) != 1 {
		t.Fatalf("calls %#v", run.calls)
	}
	if _, err := os.Stat(filepath.Join(executor.StateDir, "stopped.json.corrupt")); err != nil {
		t.Fatal("the corrupt list must be kept aside")
	}
}

func TestALedgerOfTheWrongShapeStartsEmpty(t *testing.T) {
	executor, run := newExecutor(t)
	if err := os.MkdirAll(executor.StateDir, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(executor.StateDir, "executed.json"), []byte("null"), 0o600); err != nil {
		t.Fatal(err)
	}
	writeRequest(t, executor.RequestDir, idA+".json", request(idA, "docker", "adguard", "restart", executorNow.Add(time.Minute)))
	if err := executor.Execute(context.Background()); err != nil {
		t.Fatalf("execute: %v", err)
	}
	if len(run.calls) != 1 {
		t.Fatalf("calls %#v", run.calls)
	}
}
