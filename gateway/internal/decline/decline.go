// Package decline is how the native path says "this one is Node's": an
// error that sends the request to Node with its bytes unchanged, as long as
// no byte has gone to the client yet (docs/GO_GATEWAY.md, Phase 2c,
// "Refusals are Node's").
package decline

import (
	"errors"
	"fmt"

	"github.com/some-du6e/10router/gateway/internal/claudeprep"
)

// Error is a decline from one of the native packages.
type Error struct {
	// Pkg is the package that declined ("route", "clientauth", ...).
	Pkg    string
	Reason string
}

func (e *Error) Error() string { return e.Pkg + ": proxy to Node: " + e.Reason }

// New is a decline from pkg.
func New(pkg, format string, args ...any) error {
	return &Error{Pkg: pkg, Reason: fmt.Sprintf(format, args...)}
}

// Is reports whether err sends the request to Node: a decline from any
// native package, claudeprep's included.
func Is(err error) bool {
	var d *Error
	return errors.As(err, &d) || claudeprep.IsDecline(err)
}

// ASCII declines s unless it is printable ASCII. Model ids and keys are
// matched with JavaScript's trim, case and Latin-1 header rules, which follow
// Unicode where Go's differ letter by letter; on printable ASCII they agree.
func ASCII(pkg, what, s string) error {
	for i := 0; i < len(s); i++ {
		if s[i] < 0x20 || s[i] > 0x7e {
			return New(pkg, "%s is not printable ASCII", what)
		}
	}
	return nil
}
