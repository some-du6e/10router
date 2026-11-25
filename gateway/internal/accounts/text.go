package accounts

import "github.com/some-du6e/10router/gateway/internal/db/jsjson"

// The JavaScript string helpers the port reads with.
var (
	jsTrim   = jsjson.Trim
	utf16Len = jsjson.UTF16Len
)
