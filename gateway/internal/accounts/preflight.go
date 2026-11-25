package accounts

import (
	"context"
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

// plainBaseURL: printable ASCII with no IPv6 literal, backslash or user
// info, and no port with a leading zero, so net/url reads it as WHATWG URL
// does (no punycode, no port or bracket normalization).
func plainBaseURL(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] <= 0x20 || s[i] >= 0x7f || s[i] == '\\' || s[i] == '[' || s[i] == '@' {
			return false
		}
	}
	rest := s
	if i := strings.Index(rest, "://"); i >= 0 {
		rest = rest[i+3:]
	}
	if i := strings.IndexAny(rest, "/?#"); i >= 0 {
		rest = rest[:i]
	}
	if i := strings.LastIndexByte(rest, ':'); i >= 0 && strings.HasPrefix(rest[i+1:], "0") {
		return false
	}
	return true
}
