//go:build linux

package metrics

import (
	"bufio"
	"fmt"
	"os"
	"strconv"
	"strings"
	"syscall"
	"time"
)

type cpuSample struct {
	idle  uint64
	total uint64
}

func collectPlatform() (Snapshot, error) {
	first, err := readCPU()
	if err != nil {
		return Snapshot{}, err
	}
	time.Sleep(200 * time.Millisecond)
	second, err := readCPU()
	if err != nil {
		return Snapshot{}, err
	}

	cpu := cpuUsage(first, second)
	memoryUsed, memoryTotal, err := readMemory()
	if err != nil {
		return Snapshot{}, err
	}
	diskUsed, diskTotal, err := readDisk("/")
	if err != nil {
		return Snapshot{}, err
	}
	load1, load5, load15, err := readLoad()
	if err != nil {
		return Snapshot{}, err
	}
	uptime, err := readUptime()
	if err != nil {
		return Snapshot{}, err
	}

	return Snapshot{
		CPUPercent:       &cpu,
		MemoryUsedBytes:  &memoryUsed,
		MemoryTotalBytes: &memoryTotal,
		DiskUsedBytes:    &diskUsed,
		DiskTotalBytes:   &diskTotal,
		Load1:            &load1,
		Load5:            &load5,
		Load15:           &load15,
		UptimeSeconds:    &uptime,
	}, nil
}

func readCPU() (cpuSample, error) {
	file, err := os.Open("/proc/stat")
	if err != nil {
		return cpuSample{}, err
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	if !scanner.Scan() {
		return cpuSample{}, fmt.Errorf("missing aggregate CPU line")
	}
	fields := strings.Fields(scanner.Text())
	if len(fields) < 8 || fields[0] != "cpu" {
		return cpuSample{}, fmt.Errorf("invalid aggregate CPU line")
	}

	var values []uint64
	for _, field := range fields[1:] {
		value, err := strconv.ParseUint(field, 10, 64)
		if err != nil {
			return cpuSample{}, err
		}
		values = append(values, value)
	}

	var total uint64
	for _, value := range values {
		total += value
	}
	return cpuSample{idle: values[3] + values[4], total: total}, nil
}

func cpuUsage(first, second cpuSample) float64 {
	totalDelta := second.total - first.total
	if totalDelta == 0 {
		return 0
	}
	idleDelta := second.idle - first.idle
	return float64(totalDelta-idleDelta) / float64(totalDelta) * 100
}

func readMemory() (used int64, total int64, err error) {
	data, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return 0, 0, err
	}

	values := map[string]int64{}
	scanner := bufio.NewScanner(strings.NewReader(string(data)))
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 2 {
			continue
		}
		value, parseErr := strconv.ParseInt(fields[1], 10, 64)
		if parseErr == nil {
			values[strings.TrimSuffix(fields[0], ":")] = value * 1024
		}
	}

	total = values["MemTotal"]
	available := values["MemAvailable"]
	if total <= 0 {
		return 0, 0, fmt.Errorf("MemTotal is missing")
	}
	return total - available, total, nil
}

// diskUsage reports the same bytes df does. Free blocks, not available blocks:
// a filesystem reserves a slice for root, and counting that slice as used
// overstates a large disk by the whole reservation.
func diskUsage(blocks, free uint64, blockSize int64) (used int64, total int64) {
	total = int64(blocks) * blockSize
	return total - int64(free)*blockSize, total
}

func readDisk(path string) (used int64, total int64, err error) {
	var stat syscall.Statfs_t
	if err := syscall.Statfs(path, &stat); err != nil {
		return 0, 0, err
	}

	used, total = diskUsage(uint64(stat.Blocks), uint64(stat.Bfree), int64(stat.Bsize))
	return used, total, nil
}

func readLoad() (float64, float64, float64, error) {
	data, err := os.ReadFile("/proc/loadavg")
	if err != nil {
		return 0, 0, 0, err
	}
	fields := strings.Fields(string(data))
	if len(fields) < 3 {
		return 0, 0, 0, fmt.Errorf("invalid /proc/loadavg")
	}

	values := make([]float64, 3)
	for index := range values {
		value, parseErr := strconv.ParseFloat(fields[index], 64)
		if parseErr != nil {
			return 0, 0, 0, parseErr
		}
		values[index] = value
	}
	return values[0], values[1], values[2], nil
}

func readUptime() (int64, error) {
	data, err := os.ReadFile("/proc/uptime")
	if err != nil {
		return 0, err
	}
	fields := strings.Fields(string(data))
	if len(fields) == 0 {
		return 0, fmt.Errorf("invalid /proc/uptime")
	}
	value, err := strconv.ParseFloat(fields[0], 64)
	return int64(value), err
}
