// Package supervisor runs the Node app server as the gateway's child: one
// container, the gateway on the public port, Node on a loopback one. The child
// inherits stdout and stderr, so its log lines reach the container log as
// before; it gets the shutdown signals the gateway gets; and it dies with the
// gateway (on Linux, through the parent-death signal).
package supervisor

import (
	"errors"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
)

// Child is a running app server.
type Child struct {
	cmd  *exec.Cmd
	done chan struct{}
	mu   sync.Mutex
	code int
}

// Start runs argv with env. It returns once the process has started.
func Start(argv []string, env []string) (*Child, error) {
	if len(argv) == 0 {
		return nil, errors.New("supervisor: no command")
	}
	path, err := exec.LookPath(argv[0])
	if err != nil {
		return nil, err
	}
	cmd := exec.Command(path, argv[1:]...)
	cmd.Env = env
	cmd.Stdin = nil
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.SysProcAttr = sysProcAttr()
	c := &Child{cmd: cmd, done: make(chan struct{})}
	started := make(chan error, 1)
	go func() {
		// The parent-death signal fires when the thread that started the
		// child exits, not the process, so that thread must outlive the
		// child: this goroutine keeps it locked until Wait returns.
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		if err := cmd.Start(); err != nil {
			started <- err
			return
		}
		started <- nil
		_ = cmd.Wait()
		c.mu.Lock()
		c.code = exitCodeOf(cmd.ProcessState)
		c.mu.Unlock()
		close(c.done)
	}()
	if err := <-started; err != nil {
		return nil, err
	}
	return c, nil
}

// Done is closed once the child has exited.
func (c *Child) Done() <-chan struct{} { return c.done }

// ExitCode is the child's exit code once Done is closed: its own code, or 128
// plus the signal that killed it, as a shell reports it.
func (c *Child) ExitCode() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.code
}

// Pid is the child's process id.
func (c *Child) Pid() int { return c.cmd.Process.Pid }

// Signal sends sig to the child, unless it has exited.
func (c *Child) Signal(sig os.Signal) {
	select {
	case <-c.done:
	default:
		_ = c.cmd.Process.Signal(sig)
	}
}

// Kill ends the child at once.
func (c *Child) Kill() { c.Signal(os.Kill) }

// Env returns base with every variable named in set replaced by set's value.
func Env(base []string, set map[string]string) []string {
	out := make([]string, 0, len(base)+len(set))
	for _, kv := range base {
		name := kv
		if i := strings.IndexByte(kv, '='); i >= 0 {
			name = kv[:i]
		}
		if _, ok := set[name]; ok {
			continue
		}
		out = append(out, kv)
	}
	for name, value := range set {
		out = append(out, name+"="+value)
	}
	return out
}
