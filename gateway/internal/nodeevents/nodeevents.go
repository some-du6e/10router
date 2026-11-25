// Package nodeevents hands the Node app server the writes Node makes itself,
// through its events route (src/lib/gatewayEvents.ts), so Node's writers,
// locks and caches apply them as if Node had served the request: today the
// beta flags an endpoint rejected (chat.ts's saveDroppedBetas).
package nodeevents

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
)

// Path is Node's events route.
const Path = "/api/internal/gateway/events"

// TokenHeader carries the peer token; Node checks it in custom-server.js.
const TokenHeader = "X-9r-Gw-Events-Token"

// Client posts events to the app server on loopback. A direct request, with
// none of the relay's peer headers, is this machine's own to Node.
type Client struct {
	// Base is "http://127.0.0.1:<app port>".
	Base  string
	Token string
	HTTP  *http.Client
}

// New is a client for the app server on 127.0.0.1:appPort. No proxy: the
// transport's zero value ignores HTTP(S)_PROXY.
func New(appPort int, token string) *Client {
	return &Client{
		Base:  "http://" + net.JoinHostPort("127.0.0.1", strconv.Itoa(appPort)),
		Token: token,
		HTTP:  &http.Client{Transport: &http.Transport{MaxIdleConnsPerHost: 2}},
	}
}

// BetasLearned is saveDroppedBetas(credentials, provider, flags): flags is
// every flag the attempt dropped, which Node unions into the connection's
// providerSpecificData and, unless the key has its own endpoint URL, the
// node's. ctx bounds the call.
func (c *Client) BetasLearned(ctx context.Context, connectionID, provider string, flags []string) error {
	body, err := json.Marshal(map[string]any{"type": "betas-learned", "connectionId": connectionID, "provider": provider, "droppedBetas": flags})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.Base+Path, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(TokenHeader, c.Token)
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return fmt.Errorf("nodeevents: %w", err)
	}
	defer resp.Body.Close()
	msg, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
	if resp.StatusCode != http.StatusNoContent {
		return fmt.Errorf("nodeevents: the app server answered %d: %s", resp.StatusCode, bytes.TrimSpace(msg))
	}
	return nil
}
