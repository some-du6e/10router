// Command 10router-gateway is the Go gateway in front of the 10router Node
// app server. See docs/GO_GATEWAY.md.
//
//	10router-gateway [--] <app server command...>
//
// GATEWAY_MODE=proxy (or native) takes the public port (HOSTNAME:PORT),
// starts the command with PORT=GATEWAY_APP_PORT and HOSTNAME=127.0.0.1, and
// relays every request to it. GATEWAY_MODE=off (the default) replaces itself
// with the command, so the app server runs exactly as it would without the
// gateway.
package main

import (
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/some-du6e/10router/gateway/internal/config"
	"github.com/some-du6e/10router/gateway/internal/gateway"
)

// version is set at build time (-ldflags "-X main.version=...").
var version = "dev"

func main() {
	args := os.Args[1:]
	if len(args) > 0 && args[0] == "--version" {
		fmt.Println(version)
		return
	}
	if len(args) > 0 && args[0] == "--" {
		args = args[1:]
	}
	logger := log.New(os.Stderr, "", 0)
	cfg := config.Load(os.Getenv)
	for _, w := range cfg.Warnings {
		logger.Printf("[Gateway] %s", w)
	}
	if cfg.Mode == config.ModeOff {
		if len(args) == 0 {
			logger.Printf("[Gateway] GATEWAY_MODE is off and no app server command was given")
			os.Exit(2)
		}
		os.Exit(replaceWith(args, logger))
	}

	// Relaying to a Node this process didn't start can't prove the token is
	// on both sides, and a Node without it would take every client for local.
	if len(args) == 0 {
		logger.Printf("[Gateway] no app server command given (10router-gateway -- node custom-server.js)")
		os.Exit(2)
	}

	// Before the child starts, so a signal in between isn't lost.
	signals := make(chan os.Signal, 4)
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT)
	// As PID 1, Node ignored these (the kernel drops a default-action signal
	// to a namespace's init); Go's runtime would exit on them, with no drain.
	signal.Ignore(syscall.SIGHUP, syscall.SIGQUIT)
	os.Exit(gateway.Run(gateway.Options{
		Config:  cfg,
		Command: args,
		Env:     os.Environ(),
		Signals: signals,
		Logger:  logger,
		Version: version,
	}))
}
