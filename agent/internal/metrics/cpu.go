//go:build linux

package metrics

import (
	"sync"
	"time"
)

type cpuSample struct {
	idle  uint64
	total uint64
}

func cpuUsage(first, second cpuSample) float64 {
	totalDelta := second.total - first.total
	if second.total <= first.total {
		return 0
	}
	idleDelta := second.idle - first.idle
	if second.idle < first.idle || idleDelta > totalDelta {
		return 0
	}
	return float64(totalDelta-idleDelta) / float64(totalDelta) * 100
}

type cpuMeter struct {
	mu   sync.Mutex
	last cpuSample
	have bool
}

func (m *cpuMeter) percent(read func() (cpuSample, error), sleep func(time.Duration)) (float64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	previous := m.last
	if !m.have {
		first, err := read()
		if err != nil {
			return 0, err
		}
		sleep(200 * time.Millisecond)
		previous = first
	}
	current, err := read()
	if err != nil {
		return 0, err
	}
	m.last, m.have = current, true
	return cpuUsage(previous, current), nil
}
