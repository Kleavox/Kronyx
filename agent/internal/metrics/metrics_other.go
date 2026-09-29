//go:build !linux

package metrics

func collectPlatform() (Snapshot, error) {
	return Snapshot{}, nil
}
