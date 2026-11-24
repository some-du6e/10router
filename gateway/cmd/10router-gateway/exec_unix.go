//go:build unix

package main

import (
	"log"
	"os"
	"os/exec"
	"syscall"
)

// replaceWith execs argv in place of this process (same pid, environment and
// signals), so GATEWAY_MODE=off leaves nothing of the gateway running. It
// returns only on failure, with a shell's exit code for it.
func replaceWith(argv []string, logger *log.Logger) int {
	path, err := exec.LookPath(argv[0])
	if err != nil {
		logger.Printf("[Gateway] %s: %v", argv[0], err)
		return 127
	}
	err = syscall.Exec(path, argv, os.Environ())
	logger.Printf("[Gateway] exec %s: %v", path, err)
	return 126
}
