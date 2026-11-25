package accounts

import (
	"fmt"
	"math"
	"strconv"

	"github.com/some-du6e/10router/gateway/internal/db/jsjson"
)

// Header is one response header, as Node's Response constructor got it.
type Header struct{ Name, Value string }

// Response is a failure reply as chat.ts's handleChat returns it, before the
// early-headers wrapper and the client's format: open-sse/utils/error.js's
// errorResponse and unavailableResponse, and combo.js's final reply.
type Response struct {
	Status int
	Header []Header
	Body   []byte
}

// Response is the Response Node builds for r: unavailableResponse when
// Unavailable (its Retry-After counted from nowMs), else errorResponse.
func (r Reply) Response(nowMs float64) Response {
	if r.Unavailable {
		body := jsjson.NewObject()
		inner := jsjson.NewObject()
		inner.Set("message", r.ClientMessage())
		body.Set("error", inner)
		secs := math.Max(math.Ceil((r.RetryAfterMs-nowMs)/1000), 1)
		return Response{
			Status: r.Status,
			Header: []Header{{"Content-Type", "application/json"}, {"Retry-After", string(jsjson.AppendNumber(nil, secs))}},
			Body:   jsjson.Marshal(body),
		}
	}
	return ErrorResponse(r.Status, r.Message)
}

// ErrorResponse is errorResponse(status, message): buildErrorBody's
// OpenAI-shaped body.
func ErrorResponse(status int, message string) Response {
	typ, code := "invalid_request_error", ""
	if t, ok := tbl.ErrorTypes[strconv.Itoa(status)]; ok {
		typ, code = t.Type, t.Code
	} else if status >= 500 {
		typ, code = "server_error", "internal_server_error"
	}
	if message == "" {
		message = defaultMessage(status)
	}
	inner := jsjson.NewObject()
	inner.Set("message", message)
	inner.Set("type", typ)
	inner.Set("code", code)
	body := jsjson.NewObject()
	body.Set("error", inner)
	return Response{
		Status: status,
		Header: []Header{{"Content-Type", "application/json"}, {"Access-Control-Allow-Origin", "*"}},
		Body:   jsjson.Marshal(body),
	}
}

func defaultMessage(status int) string {
	if m, ok := tbl.DefaultErrorMessages[fmt.Sprint(status)]; ok && m != "" {
		return m
	}
	return "An error occurred"
}
