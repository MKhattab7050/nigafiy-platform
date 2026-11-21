//go:build !windows

package main

import (
	"errors"
	"io"
)

var errNotSupported = errors.New("the engine service commands are not supported on this OS (use `nigafiy-engine run`)")

func isWindowsService() (bool, error)              { return false, nil }
func runAsService([]string) error                  { return errNotSupported }
func installService(_ []string, _ io.Writer) error { return errNotSupported }
func removeService() error                         { return errNotSupported }
func startService() error                          { return errNotSupported }
func stopService() error                           { return errNotSupported }
