//go:build !linux

package main

import (
	"errors"
	"os"
)

var errLinuxOnly = errors.New("service installation is supported only on Linux")

func claimDirectory(string, int, int, os.FileMode) error {
	return errLinuxOnly
}

func claimFile(string, int, int, os.FileMode) error {
	return errLinuxOnly
}
