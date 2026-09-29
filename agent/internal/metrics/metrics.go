package metrics

type Snapshot struct {
	CPUPercent       *float64 `json:"cpuPercent"`
	MemoryUsedBytes  *int64   `json:"memoryUsedBytes"`
	MemoryTotalBytes *int64   `json:"memoryTotalBytes"`
	DiskUsedBytes    *int64   `json:"diskUsedBytes"`
	DiskTotalBytes   *int64   `json:"diskTotalBytes"`
	Load1            *float64 `json:"load1"`
	Load5            *float64 `json:"load5"`
	Load15           *float64 `json:"load15"`
	UptimeSeconds    *int64   `json:"uptimeSeconds"`
}

func Collect() (Snapshot, error) {
	return collectPlatform()
}
