//go:build !unix

package supervisor

import "os"

func exitCodeOf(ps *os.ProcessState) int {
	if ps == nil || ps.ExitCode() < 0 {
		return 1
	}
	return ps.ExitCode()
}
