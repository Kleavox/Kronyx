package actions

import (
	"cmp"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"slices"
	"strings"
	"time"

	"github.com/Kleavox/krynodes/agent/internal/reporter"
)

type Service = reporter.ServiceEntry

type Runner func(ctx context.Context, name string, args ...string) ([]byte, int, error)

const maxServices = 500

var collectTimeout = 30 * time.Second

type Inventory struct {
	Hash     string    `json:"hash"`
	TakenAt  string    `json:"takenAt"`
	Services []Service `json:"services"`
}

var unitStates = map[string]string{
	"active": "running", "reloading": "running", "activating": "starting",
	"deactivating": "starting", "failed": "failed", "inactive": "stopped",
}

var containerStates = map[string]string{
	"running": "running", "restarting": "starting", "created": "stopped",
	"paused": "stopped", "exited": "stopped", "removing": "stopped", "dead": "failed",
}

func parseUnits(units, files string, remembered []string) []Service {
	on := map[string]bool{}
	present := map[string]bool{}
	for line := range strings.SplitSeq(files, "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		present[fields[0]] = true
		if len(fields) > 1 && strings.HasPrefix(fields[1], "enabled") {
			on[fields[0]] = true
		}
	}
	listed := map[string]bool{}
	var services []Service
	for line := range strings.SplitSeq(units, "\n") {
		fields := strings.Fields(strings.TrimLeft(line, "●* "))
		if len(fields) < 4 {
			continue
		}
		name, load, active := fields[0], fields[1], fields[2]
		state, known := unitStates[active]
		if load != "loaded" || !known || !ValidTarget("systemd", name) || Protected("systemd", name) {
			continue
		}
		if active == "inactive" && !on[name] {
			continue
		}
		listed[name] = true
		services = append(services, Service{Kind: "systemd", Name: name, State: state, System: systemUnit(name)})
	}
	for _, name := range remembered {
		if listed[name] || !ValidTarget("systemd", name) || Protected("systemd", name) || !unitFileExists(present, name) {
			continue
		}
		listed[name] = true
		services = append(services, Service{Kind: "systemd", Name: name, State: "stopped", System: systemUnit(name)})
	}
	return services
}

func unitFileExists(present map[string]bool, name string) bool {
	if present[name] {
		return true
	}
	if at := strings.Index(name, "@"); at >= 0 {
		return present[name[:at+1]+".service"]
	}
	return false
}

func parseContainers(output string) []Service {
	var services []Service
	for line := range strings.SplitSeq(output, "\n") {
		names, raw, found := strings.Cut(strings.TrimSpace(line), "\t")
		if !found {
			continue
		}
		name, _, _ := strings.Cut(names, ",")
		state, known := containerStates[raw]
		if !known || !ValidTarget("docker", name) {
			continue
		}
		services = append(services, Service{Kind: "docker", Name: name, State: state})
	}
	return services
}

func NewInventory(services []Service, now time.Time) (Inventory, error) {
	sorted := slices.Clone(services)
	if sorted == nil {
		sorted = []Service{}
	}
	slices.SortFunc(sorted, func(a, b Service) int {
		return cmp.Or(cmp.Compare(rank(a), rank(b)), cmp.Compare(a.Kind, b.Kind), cmp.Compare(a.Name, b.Name))
	})
	if len(sorted) > maxServices {
		sorted = sorted[:maxServices]
	}
	encoded, err := json.Marshal(sorted)
	if err != nil {
		return Inventory{}, err
	}
	sum := sha256.Sum256(encoded)
	return Inventory{Hash: hex.EncodeToString(sum[:]), TakenAt: now.UTC().Format(time.RFC3339Nano), Services: sorted}, nil
}

func rank(service Service) int {
	if service.System {
		return 1
	}
	return 0
}

func Collect(ctx context.Context, run Runner, remembered []string) ([]Service, error) {
	step := func(name string, args ...string) ([]byte, error) {
		ctx, cancel := context.WithTimeout(ctx, collectTimeout)
		defer cancel()
		output, _, err := run(ctx, name, args...)
		return output, err
	}
	units, err := step("systemctl", "list-units", "--type=service", "--all", "--no-legend", "--plain", "--no-pager")
	if err != nil {
		return nil, fmt.Errorf("list units: %w", err)
	}
	files, err := step("systemctl", "list-unit-files", "--type=service", "--no-legend", "--plain", "--no-pager")
	if err != nil {
		return nil, fmt.Errorf("list unit files: %w", err)
	}
	services := parseUnits(string(units), string(files), remembered)
	if containers, err := step("docker", "ps", "-a", "--no-trunc", "--format", "{{.Names}}\t{{.State}}"); err == nil {
		services = append(services, parseContainers(string(containers))...)
	}
	return services, nil
}

func RunCommand(ctx context.Context, name string, args ...string) ([]byte, int, error) {
	command := exec.CommandContext(ctx, name, args...)
	command.WaitDelay = 5 * time.Second
	output, err := command.CombinedOutput()
	if exitErr, ok := errors.AsType[*exec.ExitError](err); ok {
		return output, exitErr.ExitCode(), err
	}
	if err != nil {
		return output, -1, err
	}
	return output, 0, nil
}
