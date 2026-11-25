package upstream

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/some-du6e/10router/gateway/internal/claudeprep"
)

// Prepare builds the upstream request for the connection's settings n:
// claudeprep.Prepare with the attempt's inputs and n as Connection.Node.
type Prepare func(n claudeprep.NodeSettings) (*claudeprep.Request, error)

// Input is one attempt with one connection.
type Input struct {
	// Node is the connection's settings as Prepare got them first.
	Node    claudeprep.NodeSettings
	Prepare Prepare
	// Env is the process environment (os.Getenv when nil).
	Env Env
	// Sleep waits ms or until ctx ends (the retry delay).
	Sleep func(ctx context.Context, ms float64) error
	// OnHeadersBudget is told each send's whole headers budget, as
	// chatCore's onHeadersBudget is (model hang's probe lease).
	OnHeadersBudget func(ms float64)
	// LearnedBetas gets every flag the endpoint rejected so far when this
	// attempt learned any, as DefaultExecutor's onBetasRejected does. Node
	// writes them (saveDroppedBetas); the caller hands them over.
	LearnedBetas func(flags []string)
}

// Result is the attempt's end, before the stream: the live response for a
// success, or the failure as chatCore reports it to the account loop.
type Result struct {
	// Response is set for a 2xx; its body is the caller's to read and close.
	Response *http.Response
	// Sent is the request the response answers.
	Sent *claudeprep.Request
	// Status and Error are the failure: "[status]: message".
	Status int
	Error  string
	// HeadersTimeout: no response headers within the budget (Status 504);
	// Sent.Stream says whether the send streamed.
	HeadersTimeout bool
}

// Execute is DefaultExecutor.execute for a Messages-path node: BaseExecutor's
// send with the status retries, then up to maxBetaRetries resends without
// the beta flags a 400 named, re-running Prepare each time, the last with
// none at all. A client that left ends it with ctx's error; a failure Node
// would word or retry its own way (a network error, a redirect) wraps
// ErrNetwork, and the caller hands the request to Node.
func (s *Sender) Execute(ctx context.Context, in Input) (Result, error) {
	if in.Env == nil {
		in.Env = os.Getenv
	}
	// Preflight declines these before any send; this is the same check where
	// the setting is read, should the row change meanwhile.
	if o := in.Node.Overrides; o != nil && (o.Timeout != "" || o.Retries != "" || o.Proxy != "") {
		return Result{}, declined("an endpoint Timeout, Retries or Proxy setting")
	}
	req, err := in.Prepare(in.Node)
	if err != nil {
		return Result{}, err
	}
	res, err := s.execute(ctx, in, req)
	if err != nil || in.Node.StripBeta {
		return res.Result, err
	}
	var learned []string
	dropped := append([]string(nil), in.Node.DroppedBetas...)
	for attempt := 0; attempt <= maxBetaRetries && res.Status == http.StatusBadRequest; attempt++ {
		sent := sentBetas(res.Sent.Header)
		if len(sent) == 0 {
			break
		}
		var rejected []string
		for _, f := range parseRejectedBetas(res.bodyText) {
			if sent[f] {
				rejected = append(rejected, f)
			}
		}
		if len(rejected) == 0 {
			break
		}
		learned = append(learned, rejected...)
		dropped = appendUnique(dropped, rejected...)
		n := in.Node
		n.DroppedBetas = dropped
		n.StripBeta = attempt == maxBetaRetries
		retry, err := in.Prepare(n)
		if err != nil {
			return Result{}, err
		}
		if res, err = s.execute(ctx, in, retry); err != nil {
			return res.Result, err
		}
	}
	// A retry that ran out of time for headers throws in Node (BaseExecutor),
	// so execute ends before onBetasRejected: nothing learned is saved.
	if len(learned) > 0 && in.LearnedBetas != nil && !res.HeadersTimeout {
		in.LearnedBetas(dropped)
	}
	return res.Result, nil
}

// attempt is a Result with the failure body's text, which the beta loop reads.
type attempt struct {
	Result
	bodyText string
}

var errHeadersTimeout = errors.New("upstream: headers timeout")

// execute is BaseExecutor.execute with one URL: the headers timer, then the
// retry config for the status (DEFAULT_RETRY_CONFIG merged with the
// executor's); a network error goes to Node, which retries it itself.
func (s *Sender) execute(ctx context.Context, in Input, req *claudeprep.Request) (attempt, error) {
	budget := HeadersBudget(in.Env, req.Stream)
	if in.OnHeadersBudget != nil {
		in.OnHeadersBudget(budget.Ms * float64(tbl.Executor.FallbackCount))
	}
	used := 0
	for {
		resp, err := s.sendTimed(ctx, req, budget)
		switch {
		case errors.Is(err, errHeadersTimeout):
			// The budget is spent: no retry (and one URL, no next one).
			return attempt{Result: Result{Status: http.StatusGatewayTimeout, Error: "[504]: " + budget.TimeoutText(), HeadersTimeout: true, Sent: req}}, nil
		case err != nil:
			return attempt{}, err
		}
		if attempts, delay := retryEntry(resp.StatusCode); attempts > used {
			used++
			resp.Body.Close()
			if err := in.Sleep(ctx, delay); err != nil {
				return attempt{}, ctx.Err()
			}
			continue
		}
		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			return attempt{Result: Result{Response: resp, Sent: req}}, nil
		}
		return failure(ctx, resp, req)
	}
}

// sendTimed is one send under headersTimer: the budget ends the wait for
// response headers, not the body.
func (s *Sender) sendTimed(ctx context.Context, req *claudeprep.Request, b Budget) (*http.Response, error) {
	attemptCtx, cancel := context.WithCancelCause(ctx)
	timer := time.AfterFunc(time.Duration(b.Ms)*time.Millisecond, func() { cancel(errHeadersTimeout) })
	resp, err := s.Send(attemptCtx, req)
	stopped := timer.Stop()
	if err == nil && !stopped {
		// The budget ran out as the headers came: Node's timer and its fetch
		// can't both win, and the body is already cancelled here.
		resp.Body.Close()
		cancel(nil)
		return nil, errHeadersTimeout
	}
	if err != nil {
		defer cancel(nil)
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if !stopped && errors.Is(context.Cause(attemptCtx), errHeadersTimeout) {
			return nil, errHeadersTimeout
		}
		return nil, err
	}
	// The body is read under the attempt's context, which ends only with the
	// request's own; the timer can no longer fire.
	resp.Body = &cancelOnClose{ReadCloser: resp.Body, cancel: func() { cancel(nil) }}
	return resp, nil
}

type cancelOnClose struct {
	io.ReadCloser
	cancel func()
}

func (c *cancelOnClose) Close() error {
	err := c.ReadCloser.Close()
	c.cancel()
	return err
}

// retryEntry is resolveRetryEntry(retryConfig[status]).
func retryEntry(status int) (attempts int, delayMs float64) {
	e, ok := tbl.RetryConfig[strconv.Itoa(status)]
	if !ok {
		return 0, tbl.RetryDelayMs
	}
	if e.Number != nil {
		return int(*e.Number), tbl.RetryDelayMs
	}
	delay := tbl.RetryDelayMs
	if e.DelayMs != nil {
		delay = *e.DelayMs
	}
	if e.Attempts == nil {
		return 0, delay
	}
	return int(*e.Attempts), delay
}

// maxErrorBody bounds the error body read. Node reads it all; one this large
// is not an error message, and goes to Node.
const maxErrorBody = 8 << 20

// failure is chatCore's handling of a non-2xx response: parseUpstreamError
// with BaseExecutor.parseError (the body text, or "HTTP <status>"), then
// formatProviderError: "[status]: message".
func failure(ctx context.Context, resp *http.Response, req *claudeprep.Request) (attempt, error) {
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxErrorBody+1))
	if err != nil {
		if ctx.Err() != nil {
			return attempt{}, ctx.Err()
		}
		return attempt{}, fmt.Errorf("%w: reading the error body: %v", ErrNetwork, err)
	}
	if len(raw) > maxErrorBody {
		return attempt{}, fmt.Errorf("%w: an error body over %d bytes", ErrNetwork, maxErrorBody)
	}
	text := claudeprep.DecodeText(raw)
	message := text
	if message == "" {
		message = "HTTP " + strconv.Itoa(resp.StatusCode)
	}
	return attempt{
		Result:   Result{Status: resp.StatusCode, Error: "[" + strconv.Itoa(resp.StatusCode) + "]: " + message, Sent: req},
		bodyText: text,
	}, nil
}

// tlsEnv are the variables that change which certificates Node's fetch
// trusts; with one set the gateway would trust others, so it declines.
var tlsEnv = []string{"NODE_EXTRA_CA_CERTS", "NODE_TLS_REJECT_UNAUTHORIZED", "NODE_USE_SYSTEM_CA", "SSL_CERT_FILE", "SSL_CERT_DIR"}

// CheckTLSEnv declines when the environment changes Node's TLS trust.
func CheckTLSEnv(env Env) error {
	for _, n := range tlsEnv {
		if strings.TrimSpace(env(n)) != "" {
			return declined("%s is set (Node's TLS trust differs from the gateway's)", n)
		}
	}
	return nil
}
