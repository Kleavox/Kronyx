package actions

import (
	"os"
	"syscall"
)

const nonblocking = syscall.O_NONBLOCK

func syncDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}

func sameDirectory(before os.FileInfo, root *os.Root) bool {
	opened, err := root.Stat(".")
	return err == nil && os.SameFile(before, opened)
}
