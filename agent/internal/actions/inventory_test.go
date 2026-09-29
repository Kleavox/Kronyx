package actions

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"
)

const unitList = `nginx.service                 loaded    active   running A high performance web server
shadowsocks-libev.service     loaded    inactive dead    Shadowsocks-libev Default Server Service
● adguard.service             loaded    failed   failed  AdGuard Home
ssh.service                   loaded    active   running OpenBSD Secure Shell server
cron.service                  loaded    active   running Regular background program processing daemon
old.service                   loaded    inactive dead    Something disabled
ghost.service                 not-found inactive dead    ghost.service
backup.service                loaded    activating start Nightly backup
`

const enabledList = `nginx.service enabled enabled
shadowsocks-libev.service enabled enabled
`

func TestUnitsBecomeServices(t *testing.T) {
	got := parseUnits(unitList, enabledList, nil)
	want := []Service{
		{Kind: "systemd", Name: "nginx.service", State: "running"},
		{Kind: "systemd", Name: "shadowsocks-libev.service", State: "stopped"},
		{Kind: "systemd", Name: "adguard.service", State: "failed"},
		{Kind: "systemd", Name: "cron.service", State: "running", System: true},
		{Kind: "systemd", Name: "backup.service", State: "starting"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("units\n got %#v\nwant %#v", got, want)
	}
}

func TestContainersBecomeServices(t *testing.T) {
	got := parseContainers("adguard\trunning\nweb,web/alias\texited\nbroken\tdead\nbad/name\trunning\nwarming\trestarting\n\n")
	want := []Service{
		{Kind: "docker", Name: "adguard", State: "running"},
		{Kind: "docker", Name: "web", State: "stopped"},
		{Kind: "docker", Name: "broken", State: "failed"},
		{Kind: "docker", Name: "warming", State: "starting"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("containers\n got %#v\nwant %#v", got, want)
	}
}

func TestTheHashIgnoresOrderButNotState(t *testing.T) {
	now := time.Date(2026, 9, 29, 10, 0, 0, 0, time.UTC)
	a := []Service{{Kind: "docker", Name: "b", State: "running"}, {Kind: "systemd", Name: "a.service", State: "running"}}
	b := []Service{a[1], a[0]}
	first, _ := NewInventory(a, now)
	second, _ := NewInventory(b, now)
	if first.Hash != second.Hash || len(first.Hash) != 64 {
		t.Fatalf("hashes differ: %s %s", first.Hash, second.Hash)
	}
	if first.Services[0].Kind != "docker" || first.TakenAt != "2026-09-29T10:00:00Z" {
		t.Fatalf("unexpected inventory %#v", first)
	}
	changed, _ := NewInventory([]Service{{Kind: "docker", Name: "b", State: "stopped"}, a[1]}, now)
	if changed.Hash == first.Hash {
		t.Fatal("a state change must change the hash")
	}
	empty, _ := NewInventory(nil, now)
	if empty.Services == nil {
		t.Fatal("an empty inventory must encode as a list")
	}
}

func TestCollectSurvivesAMissingDocker(t *testing.T) {
	var calls []string
	run := func(_ context.Context, name string, args ...string) ([]byte, int, error) {
		calls = append(calls, name+" "+strings.Join(args, " "))
		switch {
		case name == "docker":
			return nil, -1, errors.New("executable file not found")
		case args[0] == "list-units":
			return []byte(unitList), 0, nil
		default:
			return []byte(enabledList), 0, nil
		}
	}
	services, err := Collect(context.Background(), run, nil)
	if err != nil || len(services) != 5 {
		t.Fatalf("collect: %d services, err %v", len(services), err)
	}
	if calls[2] != "docker ps -a --no-trunc --format {{.Names}}\t{{.State}}" {
		t.Fatalf("unexpected docker call %q", calls[2])
	}
}

func TestCollectFailsWithoutSystemd(t *testing.T) {
	run := func(context.Context, string, ...string) ([]byte, int, error) {
		return nil, -1, errors.New("no systemctl")
	}
	if _, err := Collect(context.Background(), run, nil); err == nil {
		t.Fatal("expected an error")
	}
}

func TestCollectListsEveryUnitFileState(t *testing.T) {
	var calls []string
	run := func(_ context.Context, name string, args ...string) ([]byte, int, error) {
		calls = append(calls, name+" "+strings.Join(args, " "))
		return nil, 0, nil
	}
	if _, err := Collect(context.Background(), run, nil); err != nil {
		t.Fatal(err)
	}
	if calls[1] != "systemctl list-unit-files --type=service --no-legend --plain --no-pager" {
		t.Fatalf("unexpected unit file call %q", calls[1])
	}
}

func TestUnitsStoppedThroughKrynodesStayListed(t *testing.T) {
	files := "nginx.service enabled enabled\nmanual.service static -\nopenvpn@.service disabled enabled\n"
	got := parseUnits(unitList, files, []string{"manual.service", "openvpn@server.service", "gone.service", "nginx.service", "ssh.service"})
	want := []Service{
		{Kind: "systemd", Name: "nginx.service", State: "running"},
		{Kind: "systemd", Name: "adguard.service", State: "failed"},
		{Kind: "systemd", Name: "cron.service", State: "running", System: true},
		{Kind: "systemd", Name: "backup.service", State: "starting"},
		{Kind: "systemd", Name: "manual.service", State: "stopped"},
		{Kind: "systemd", Name: "openvpn@server.service", State: "stopped"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("units\n got %#v\nwant %#v", got, want)
	}
}

func TestCollectGivesUpOnAHungDocker(t *testing.T) {
	previous := collectTimeout
	collectTimeout = 50 * time.Millisecond
	defer func() { collectTimeout = previous }()
	run := func(ctx context.Context, name string, args ...string) ([]byte, int, error) {
		if name == "docker" {
			<-ctx.Done()
			return nil, -1, ctx.Err()
		}
		if args[0] == "list-units" {
			return []byte(unitList), 0, nil
		}
		return []byte(enabledList), 0, nil
	}
	done := make(chan int, 1)
	go func() {
		services, _ := Collect(context.Background(), run, nil)
		done <- len(services)
	}()
	select {
	case count := <-done:
		if count != 5 {
			t.Fatalf("expected the 5 units without containers, got %d", count)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Collect must not wait on a hung docker")
	}
}

func TestAnInventoryKeepsAtMost500ServicesPreferringYourOwn(t *testing.T) {
	var services []Service
	for index := range 400 {
		services = append(services, Service{Kind: "systemd", Name: fmt.Sprintf("s%03d.service", index), State: "running", System: true})
	}
	for index := range 200 {
		services = append(services, Service{Kind: "docker", Name: fmt.Sprintf("c%03d", index), State: "stopped"})
	}
	inventory, err := NewInventory(services, executorNow)
	if err != nil {
		t.Fatal(err)
	}
	own := 0
	for _, service := range inventory.Services {
		if !service.System {
			own++
		}
	}
	if len(inventory.Services) != 500 || own != 200 {
		t.Fatalf("expected 500 services with all 200 of your own, got %d and %d", len(inventory.Services), own)
	}
}
