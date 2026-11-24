//go:build linux

package supervisor

import "syscall"

// The child gets SIGKILL if the gateway dies without stopping it, so a crashed
// gateway can't leave a Node server holding the database behind. It gets its
// own process group, so a terminal's Ctrl-C or Ctrl-\ reaches only the
// gateway, which passes shutdown signals on after its own drain starts.
func sysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Pdeathsig: syscall.SIGKILL, Setpgid: true}
}
