package actions

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/Kleavox/krynodes/agent/internal/reporter"
)

const (
	maxRequestBytes = 4 << 10
	maxOutputBytes  = 2 << 10
	commandTimeout  = 2 * time.Minute
	expirySkew      = time.Minute
	keepFor         = 24 * time.Hour
)

var requestName = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$`)

type Request = reporter.ActionRequest

type Result = reporter.ActionResult

type Executor struct {
	RequestDir string
	StateDir   string
	Now        func() time.Time
	Run        Runner
	Collect    func(context.Context, []string) ([]Service, error)
}

type pending struct {
	id      string
	request Request
	refusal error
}

func (e Executor) Execute(ctx context.Context) error {
	stopped, err := readState[[]string](e.StateDir, "stopped.json")
	if err != nil {
		return err
	}
	services, err := e.Collect(ctx, stopped)
	if err != nil {
		return err
	}
	ledger, err := readState[map[string]time.Time](e.StateDir, "executed.json")
	if err != nil {
		return err
	}
	if ledger == nil {
		ledger = map[string]time.Time{}
	}
	for {
		batch := e.unprocessed(ledger)
		if len(batch) == 0 {
			break
		}
		for _, item := range batch {
			ledger[item.id] = e.Now()
			if err := e.saveLedger(ledger); err != nil {
				return err
			}
			result := e.refuse(item.id, item.refusal)
			if item.refusal == nil {
				result = e.execute(ctx, item.request, services)
				if result.OK && item.request.Kind == "systemd" {
					stopped = remember(stopped, item.request.Name, item.request.Action == "stop")
					if err := writeJSON(e.StateDir, "stopped.json", stopped, 0o640); err != nil {
						return err
					}
				}
			}
			if err := writeJSON(filepath.Join(e.StateDir, "results"), item.id+".json", result, 0o640); err != nil {
				return err
			}
		}
		if services, err = e.Collect(ctx, stopped); err != nil {
			return err
		}
	}
	inventory, err := NewInventory(services, e.Now())
	if err != nil {
		return err
	}
	if err := writeJSON(e.StateDir, "inventory.json", inventory, 0o640); err != nil {
		return err
	}
	return e.pruneResults()
}

func (e Executor) unprocessed(ledger map[string]time.Time) []pending {
	info, err := os.Lstat(e.RequestDir)
	if err != nil || !info.IsDir() {
		return nil
	}
	root, err := os.OpenRoot(e.RequestDir)
	if err != nil {
		return nil
	}
	defer root.Close()
	if !sameDirectory(info, root) {
		return nil
	}
	dir, err := root.Open(".")
	if err != nil {
		return nil
	}
	entries, err := dir.ReadDir(-1)
	dir.Close()
	if err != nil {
		return nil
	}
	var batch []pending
	for _, entry := range entries {
		name := entry.Name()
		if !requestName.MatchString(name) {
			continue
		}
		id := strings.TrimSuffix(name, ".json")
		if _, done := ledger[id]; done {
			continue
		}
		request, err := readRequest(root, name)
		if err == nil && request.ID != id {
			err = errors.New("the request id does not match its file")
		}
		batch = append(batch, pending{id: id, request: request, refusal: err})
	}
	slices.SortFunc(batch, func(a, b pending) int { return strings.Compare(a.id, b.id) })
	return batch
}

func readRequest(root *os.Root, name string) (Request, error) {
	info, err := root.Lstat(name)
	if err != nil {
		return Request{}, err
	}
	if !info.Mode().IsRegular() {
		return Request{}, errors.New("the request is not a regular file")
	}
	file, err := root.OpenFile(name, os.O_RDONLY|nonblocking, 0)
	if err != nil {
		return Request{}, err
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil {
		return Request{}, err
	}
	if !opened.Mode().IsRegular() {
		return Request{}, errors.New("the request is not a regular file")
	}
	if opened.Size() > maxRequestBytes {
		return Request{}, errors.New("the request is too large")
	}
	raw, err := io.ReadAll(io.LimitReader(file, maxRequestBytes+1))
	if err != nil {
		return Request{}, err
	}
	if len(raw) > maxRequestBytes {
		return Request{}, errors.New("the request is too large")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var request Request
	if err := decoder.Decode(&request); err != nil {
		return Request{}, fmt.Errorf("the request is not valid: %w", err)
	}
	return request, nil
}

func check(request Request, now time.Time, services []Service) error {
	switch request.Action {
	case "start", "stop", "restart":
	default:
		return fmt.Errorf("unknown action %q", request.Action)
	}
	if !ValidTarget(request.Kind, request.Name) {
		return errors.New("invalid target")
	}
	if Protected(request.Kind, request.Name) {
		return fmt.Errorf("%s is protected", request.Name)
	}
	expires, err := time.Parse(time.RFC3339Nano, request.ExpiresAt)
	if err != nil {
		return errors.New("invalid expiry")
	}
	if now.After(expires.Add(expirySkew)) {
		return fmt.Errorf("the request expired at %s", request.ExpiresAt)
	}
	for _, service := range services {
		if service.Kind == request.Kind && service.Name == request.Name {
			return nil
		}
	}
	return fmt.Errorf("%s is not on this server", request.Name)
}

func (e Executor) execute(ctx context.Context, request Request, services []Service) Result {
	if err := check(request, e.Now(), services); err != nil {
		return e.refuse(request.ID, err)
	}
	ctx, cancel := context.WithTimeout(ctx, commandTimeout)
	defer cancel()
	program := "systemctl"
	if request.Kind == "docker" {
		program = "docker"
	}
	action := request.Action
	if request.Kind == "docker" && action == "start" {
		paused, _, err := e.Run(ctx, "docker", "inspect", "--format", "{{.State.Paused}}", "--", request.Name)
		if err == nil && strings.TrimSpace(string(paused)) == "true" {
			action = "unpause"
		}
	}
	output, code, err := e.Run(ctx, program, action, "--", request.Name)
	result := Result{ID: request.ID, OK: err == nil, Output: clean(output), FinishedAt: e.stamp()}
	if code >= 0 {
		result.ExitCode = &code
	}
	if err != nil && result.Output == "" {
		result.Output = clean([]byte(err.Error()))
	}
	return result
}

func remember(stopped []string, name string, keep bool) []string {
	next := slices.DeleteFunc(slices.Clone(stopped), func(entry string) bool { return entry == name })
	if keep {
		next = append(next, name)
		slices.Sort(next)
	}
	return next
}

func (e Executor) refuse(id string, err error) Result {
	if err == nil {
		return Result{}
	}
	return Result{ID: id, OK: false, Output: clean([]byte("refused: " + err.Error())), FinishedAt: e.stamp()}
}

func (e Executor) stamp() string {
	return e.Now().UTC().Format(time.RFC3339Nano)
}

func readState[T any](directory, name string) (T, error) {
	var value T
	path := filepath.Join(directory, name)
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return value, nil
	}
	if err != nil {
		return value, err
	}
	if err := json.Unmarshal(raw, &value); err != nil {
		log.Printf("%s is unreadable, set aside as %s.corrupt: %v", name, name, err)
		var empty T
		return empty, os.Rename(path, path+".corrupt")
	}
	return value, nil
}

func (e Executor) saveLedger(ledger map[string]time.Time) error {
	for id, at := range ledger {
		if e.Now().Sub(at) > keepFor {
			delete(ledger, id)
		}
	}
	return writeJSON(e.StateDir, "executed.json", ledger, 0o600)
}

func (e Executor) pruneResults() error {
	directory := filepath.Join(e.StateDir, "results")
	entries, err := os.ReadDir(directory)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	for _, entry := range entries {
		info, err := entry.Info()
		if err == nil && e.Now().Sub(info.ModTime()) > keepFor {
			if err := os.Remove(filepath.Join(directory, entry.Name())); err != nil && !errors.Is(err, os.ErrNotExist) {
				return err
			}
		}
	}
	return nil
}

func clean(output []byte) string {
	text := strings.Map(func(r rune) rune {
		if r == '\n' || r == '\t' {
			return r
		}
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, strings.ToValidUTF8(string(output), ""))
	text = strings.TrimSpace(text)
	if len(text) > maxOutputBytes {
		text = text[:maxOutputBytes]
		for !utf8.ValidString(text) {
			text = text[:len(text)-1]
		}
	}
	return text
}

func readJSON(path string, value any) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(raw, value)
}

func writeJSON(directory, name string, value any, mode os.FileMode) error {
	encoded, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(directory, 0o750); err != nil {
		return err
	}
	temporary := filepath.Join(directory, "."+name+".tmp")
	file, err := os.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	if _, err := file.Write(encoded); err != nil {
		file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	return os.Rename(temporary, filepath.Join(directory, name))
}
