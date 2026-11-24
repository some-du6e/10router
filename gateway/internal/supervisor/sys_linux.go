//go:build linux

package supervisor

import "syscall"

// The child gets SIGKILL if the gateway dies without stopping it, so a crashed
// gateway can't leave a Node server holding the database behind.
func sysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Pdeathsig: syscall.SIGKILL}
}
