//go:build linux

package metrics

import (
	"testing"
	"time"
)

func TestCPUUsesTheWholeIntervalOnceItHasAPreviousSample(t *testing.T) {
	samples := []cpuSample{{idle: 100, total: 200}, {idle: 150, total: 300}, {idle: 160, total: 400}}
	reads := 0
	read := func() (cpuSample, error) {
		sample := samples[reads]
		reads++
		return sample, nil
	}
	slept := 0
	sleep := func(time.Duration) { slept++ }
	var meter cpuMeter

	first, err := meter.percent(read, sleep)
	if err != nil || first != 50 || slept != 1 || reads != 2 {
		t.Fatalf("first %v err %v slept %d reads %d", first, err, slept, reads)
	}
	second, err := meter.percent(read, sleep)
	if err != nil || second != 90 || slept != 1 || reads != 3 {
		t.Fatalf("second %v err %v slept %d reads %d", second, err, slept, reads)
	}
}
