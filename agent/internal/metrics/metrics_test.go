//go:build linux

package metrics

import "testing"

func TestDiskUsageCountsOnlyOccupiedBlocks(t *testing.T) {
	const blockSize = 4096
	const blocks = 263939740 // about 1.08 TB, the size of a WSL root volume
	const free = 263156506   // what the filesystem reports as free

	used, total := diskUsage(blocks, free, blockSize)

	if total != blocks*blockSize {
		t.Fatalf("total = %d, want %d", total, blocks*blockSize)
	}
	if want := int64((blocks - free) * blockSize); used != want {
		t.Fatalf("used = %d, want %d", used, want)
	}
}

func TestDiskUsageIgnoresTheRootReservation(t *testing.T) {
	const blockSize = 4096
	const blocks = 1000000
	const free = 950000
	const available = 900000 // 5% of the volume is held back for root

	used, _ := diskUsage(blocks, free, blockSize)

	reservedAsUsed := int64((blocks - available) * blockSize)
	if used == reservedAsUsed {
		t.Fatal("used counted the root reservation, which df does not")
	}
	if want := int64((blocks - free) * blockSize); used != want {
		t.Fatalf("used = %d, want %d", used, want)
	}
}

func TestDiskUsageOnAnEmptyVolume(t *testing.T) {
	used, total := diskUsage(1000, 1000, 4096)
	if used != 0 {
		t.Fatalf("used = %d on an empty volume, want 0", used)
	}
	if total != 4096000 {
		t.Fatalf("total = %d, want 4096000", total)
	}
}
