package actions

import (
	"os"
	"syscall"
)

const nonblocking = syscall.O_NONBLOCK

func sameDirectory(before os.FileInfo, root *os.Root) bool {
	opened, err := root.Stat(".")
	return err == nil && os.SameFile(before, opened)
}
