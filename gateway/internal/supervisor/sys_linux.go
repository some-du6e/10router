//go:build linux

package supervisor

import "syscall"

// The child gets SIGKILL if the gateway dies without stopping it, so a crashed
// gateway can't leave a Node server holding the database behind. It gets its
// own process group, so a terminal's signals reach only the gateway: Ctrl-C
// drains (the gateway passes it on once its own drain has started), Ctrl-\
// is ignored.
func sysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Pdeathsig: syscall.SIGKILL, Setpgid: true}
}
