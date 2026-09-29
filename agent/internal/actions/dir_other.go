//go:build !linux

package actions

import "os"

const nonblocking = 0

func sameDirectory(os.FileInfo, *os.Root) bool { return true }

func syncDirectory(string) error { return nil }
