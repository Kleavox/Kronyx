package main

import (
	"errors"
	"fmt"
	"os"
	"syscall"
)

func claimDirectory(path string, uid, gid int, mode os.FileMode) error {
	info, err := os.Lstat(path)
	switch {
	case errors.Is(err, os.ErrNotExist):
	case err != nil:
		return err
	case info.Mode()&os.ModeSymlink != 0 || !info.IsDir():
		if err := os.Remove(path); err != nil {
			return fmt.Errorf("replace %s: %w", path, err)
		}
	}
	if err := os.Mkdir(path, mode); err != nil && !errors.Is(err, os.ErrExist) {
		return err
	}
	return claim(path, syscall.O_DIRECTORY, uid, gid, mode)
}

func claimFile(path string, uid, gid int, mode os.FileMode) error {
	return claim(path, 0, uid, gid, mode)
}

func claim(path string, flags, uid, gid int, mode os.FileMode) error {
	file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK|flags, 0)
	if err != nil {
		return fmt.Errorf("open %s without following links: %w", path, err)
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return err
	}
	if flags&syscall.O_DIRECTORY == 0 && !info.Mode().IsRegular() {
		return fmt.Errorf("%s is not a regular file", path)
	}
	if err := file.Chown(uid, gid); err != nil {
		return err
	}
	return file.Chmod(mode)
}
