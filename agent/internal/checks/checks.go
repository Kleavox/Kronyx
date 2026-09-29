package checks

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/Kleavox/krynodes/agent/internal/reporter"
)

func RunAll(ctx context.Context, definitions []reporter.Check) []reporter.CheckResult {
	results := make([]reporter.CheckResult, len(definitions))
	semaphore := make(chan struct{}, 4)
	var wait sync.WaitGroup

	for index, definition := range definitions {
		wait.Add(1)
		go func() {
			defer wait.Done()
			semaphore <- struct{}{}
			defer func() { <-semaphore }()
			results[index] = Run(ctx, definition)
		}()
	}
	wait.Wait()
	return results
}

func Run(ctx context.Context, check reporter.Check) reporter.CheckResult {
	timeout := time.Duration(check.TimeoutSeconds) * time.Second
	if timeout < time.Second || timeout > 30*time.Second {
		timeout = 10 * time.Second
	}
	checkCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	started := time.Now()
	var err error
	switch check.Kind {
	case "HTTP":
		err = runHTTP(checkCtx, check.Target)
	case "TCP":
		err = runTCP(checkCtx, check.Target)
	case "SERVICE":
		err = runService(checkCtx, check.Target)
	default:
		err = fmt.Errorf("unsupported check kind")
	}

	latency := time.Since(started).Milliseconds()
	checkedAt := time.Now().UTC().Format(time.RFC3339)
	if err != nil {
		message := truncate(err.Error(), 500)
		return reporter.CheckResult{
			CheckID: check.ID, Status: "DOWN", LatencyMS: &latency,
			Message: &message, CheckedAt: checkedAt,
		}
	}
	return reporter.CheckResult{
		CheckID: check.ID, Status: "UP", LatencyMS: &latency,
		CheckedAt: checkedAt,
	}
}

func runHTTP(ctx context.Context, target string) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return err
	}
	request.Header.Set("User-Agent", "kry-agent-check")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode >= 500 {
		return fmt.Errorf("HTTP %d", response.StatusCode)
	}
	return nil
}

func runTCP(ctx context.Context, target string) error {
	connection, err := (&net.Dialer{}).DialContext(ctx, "tcp", target)
	if err != nil {
		return err
	}
	return connection.Close()
}

func runService(ctx context.Context, target string) error {
	if strings.ContainsAny(target, " \t\r\n/\\;&|`$(){}[]") {
		return fmt.Errorf("invalid service unit")
	}
	return exec.CommandContext(ctx, "systemctl", "is-active", "--quiet", target).Run()
}

func truncate(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	return value[:limit]
}
