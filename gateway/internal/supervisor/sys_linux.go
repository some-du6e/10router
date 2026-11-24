//go:build linux

package supervisor

import "syscall"

// The child gets SIGKILL if the gateway dies without stopping it, so a crashed
// gateway can't leave a Node server holding the database behind. It gets its
// own process group, so a terminal's signals reach only the gateway, which
// decides what goes on: Ctrl-C drains (passed on once the gateway's own drain
// has started), and Ctrl-\ goes on only to a Node handler configured on it.
func sysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Pdeathsig: syscall.SIGKILL, Setpgid: true}
}
