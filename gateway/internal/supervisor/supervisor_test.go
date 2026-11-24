package supervisor

import (
	"os"
	"os/exec"
	"slices"
	"syscall"
	"testing"
	"time"
)

func TestEnvReplaces(t *testing.T) {
	got := Env([]string{"PORT=20128", "HOME=/root", "HOSTNAME=0.0.0.0", "WEIRD"}, map[string]string{"PORT": "20129", "HOSTNAME": "127.0.0.1"})
	slices.Sort(got)
	want := []string{"HOME=/root", "HOSTNAME=127.0.0.1", "PORT=20129", "WEIRD"}
	if !slices.Equal(got, want) {
		t.Fatalf("Env = %v, want %v", got, want)
	}
}

func TestExitCodes(t *testing.T) {
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skip("no sh")
	}
	c, err := Start([]string{"sh", "-c", "exit 7"}, os.Environ())
	if err != nil {
		t.Fatal(err)
	}
	<-c.Done()
	if c.ExitCode() != 7 {
		t.Errorf("exit code %d", c.ExitCode())
	}

	c, err = Start([]string{"sh", "-c", "sleep 30"}, os.Environ())
	if err != nil {
		t.Fatal(err)
	}
	c.Signal(syscall.SIGTERM)
	select {
	case <-c.Done():
	case <-time.After(5 * time.Second):
		c.Kill()
		t.Fatal("the signal did not reach the child")
	}
	if c.ExitCode() != 128+int(syscall.SIGTERM) {
		t.Errorf("exit code %d, want %d", c.ExitCode(), 128+int(syscall.SIGTERM))
	}
	// Signalling an exited child is harmless.
	c.Signal(syscall.SIGTERM)
}

func TestStartFails(t *testing.T) {
	if _, err := Start([]string{"/nonexistent/app-server"}, nil); err == nil {
		t.Fatal("started a missing command")
	}
	if _, err := Start(nil, nil); err == nil {
		t.Fatal("started nothing")
	}
}
