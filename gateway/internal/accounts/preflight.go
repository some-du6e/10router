package accounts

import (
	"context"
	"regexp"
	"strings"

	"github.com/some-du6e/10router/gateway/internal/db"
)

// CheckProvider declines, before anything is sent, what the loop for
// provider and model would have to decline later: a selection strategy it
// doesn't serve (soonest-reset, a value that isn't a string, a sticky limit
// that isn't a number), and on every key a stored field Node reads its own
// way, a demotion record, a base URL Go can't canonicalize the way WHATWG URL
// does (keysShareOneUpstream compares them), and whatever check says about it.
// check is the sender's: upstream.Preflight, and a dry run of
// claudeprep.Prepare for the key and model, whose declines on a key's
// settings or the model's route would otherwise come mid-loop. A decline
// mid-loop hands Node rows Go has already written; this keeps config declines
// ahead of every write. A failure only a send can show (a 401, a network
// error) still hands off after it.
func (a *Accounts) CheckProvider(ctx context.Context, provider string, s Settings, check func(*db.Connection) error) error {
	if !strings.HasPrefix(provider, "openai-compatible-") {
		return declined("provider %s is not an openai-compatible node", provider)
	}
	strategy, err := Strategy(s, provider)
	if err != nil {
		return err
	}
	if strategy == "round-robin" {
		if _, err := stickyLimit(s, provider); err != nil {
			return err
		}
	}
	rows, err := a.Store.ListConnections(ctx, provider, nil)
	if err != nil {
		return err
	}
	for _, r := range rows {
		if !r.IsActive {
			continue
		}
		c := conn{r}
		if err := c.checkDates(); err != nil {
			return err
		}
		if c.hasDemotion() {
			return declined("connection %s has a demotion record (dead-key evidence is Node's)", r.ID)
		}
		base, _ := r.ProviderSpecificData().Get("baseUrl")
		if !plainBaseURL(jsString(base)) {
			return declined("connection %s has a base URL Go doesn't canonicalize as WHATWG URL does", r.ID)
		}
		if check != nil {
			if err := check(r); err != nil {
				return err
			}
		}
	}
	return nil
}

// plainBaseURLRe is the base URLs net/url and WHATWG URL read alike: a
// lowercase-safe ASCII host, an optional port with no leading zero, path
// segments of unreserved characters, and a query of unreserved characters
// and = &. Anything else is declined rather than compared: punycode, an
// empty port, escapes, characters one parser escapes and the other doesn't.
var plainBaseURLRe = regexp.MustCompile(`^https?://[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*(:[1-9][0-9]{0,4})?(/[A-Za-z0-9._~-]*)*(\?[A-Za-z0-9._~=&-]*)?$`)

// plainBaseURL: no base URL at all (the provider's default), or one
// plainBaseURLRe takes with no "." or ".." segment (WHATWG URL resolves
// those; net/url sends them).
func plainBaseURL(s string) bool {
	if s == "" {
		return true
	}
	if !plainBaseURLRe.MatchString(s) {
		return false
	}
	path := s
	if i := strings.IndexByte(path, '?'); i >= 0 {
		path = path[:i]
	}
	for _, seg := range strings.Split(path, "/") {
		if seg == "." || seg == ".." {
			return false
		}
	}
	return true
}
