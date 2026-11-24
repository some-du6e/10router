//go:build !unix

package main

import (
	"errors"
	"log"
	"os"
	"os/exec"
)

// replaceWith runs argv and exits with its code (no exec(2) here).
func replaceWith(argv []string, logger *log.Logger) int {
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	err := cmd.Run()
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		return exit.ExitCode()
	}
	if err != nil {
		logger.Printf("[Gateway] %s: %v", argv[0], err)
		return 127
	}
	return 0
}
