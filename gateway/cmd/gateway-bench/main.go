// Command gateway-bench measures what the gateway's hop costs: the same
// requests straight to the app server and through the gateway, with latency
// percentiles and the CPU each process spent (from /proc, Linux only). It
// prints a Markdown table.
//
//	gateway-bench -direct http://127.0.0.1:18081 -proxy http://127.0.0.1:18080 \
//	  -gateway-pid 123 -app-pid 124
package main

import (
	"bytes"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

type scenario struct {
	name string
	path string
	body []byte
	n    int
}

type result struct {
	latencies []time.Duration
	wall      time.Duration
	errors    int
	appCPU    time.Duration
	gwCPU     time.Duration
}

func main() {
	direct := flag.String("direct", "http://127.0.0.1:18081", "app server URL")
	proxied := flag.String("proxy", "http://127.0.0.1:18080", "gateway URL")
	n := flag.Int("n", 3000, "requests per small/SSE run")
	bigN := flag.Int("big-n", 200, "requests per 4 MB run")
	concurrency := flag.Int("c", 16, "concurrent clients")
	gwPid := flag.Int("gateway-pid", 0, "gateway pid, for its CPU time")
	appPid := flag.Int("app-pid", 0, "app server pid, for its CPU time")
	rounds := flag.Int("rounds", 3, "alternating direct/proxy rounds per scenario; the median round is reported")
	flag.Parse()

	small := bytes.Repeat([]byte(`{"k":"v"},`), 100)
	small = append(append([]byte(`{"messages":[`), small[:len(small)-1]...), []byte(`]}`)...)
	big := bytes.Repeat([]byte("0123456789abcdef"), (4<<20)/16)
	scenarios := []scenario{
		{"small JSON (1 KB in, 30 B out)", "/small", small, *n},
		{"SSE (2 KB in, 51 events / 13 KB out)", "/sse", small[:2000], *n},
		{"4 MB body in", "/big", big, *bigN},
	}

	client := &http.Client{Transport: &http.Transport{
		MaxIdleConnsPerHost: *concurrency * 2,
		DisableCompression:  true,
		IdleConnTimeout:     time.Minute,
	}}

	fmt.Printf("Concurrency %d, %d rounds alternating direct and through the gateway; median round shown.\n\n", *concurrency, *rounds)
	fmt.Println("| Scenario | Path | p50 | p90 | p99 | req/s | errors | app CPU ms / 1k req | gateway CPU ms / 1k req |")
	fmt.Println("|---|---|---|---|---|---|---|---|---|")
	for _, s := range scenarios {
		// Warm both paths (connections, JIT).
		run(client, *direct, s, 100, *concurrency, *gwPid, *appPid)
		run(client, *proxied, s, 100, *concurrency, *gwPid, *appPid)
		var directs, proxies []result
		for i := 0; i < *rounds; i++ {
			directs = append(directs, run(client, *direct, s, s.n, *concurrency, *gwPid, *appPid))
			proxies = append(proxies, run(client, *proxied, s, s.n, *concurrency, *gwPid, *appPid))
		}
		d, p := median(directs), median(proxies)
		row(s, "direct", d, false)
		row(s, "gateway", p, true)
		fmt.Printf("| | overhead | +%s | +%s | +%s | | | | |\n",
			ms(pct(p.latencies, 50)-pct(d.latencies, 50)), ms(pct(p.latencies, 90)-pct(d.latencies, 90)), ms(pct(p.latencies, 99)-pct(d.latencies, 99)))
	}
}

func row(s scenario, label string, r result, gw bool) {
	reqs := float64(len(r.latencies))
	gwCell := "–"
	if gw {
		gwCell = fmt.Sprintf("%.1f", float64(r.gwCPU.Milliseconds())*1000/reqs)
	}
	fmt.Printf("| %s | %s | %s | %s | %s | %.0f | %d | %.1f | %s |\n", s.name, label,
		ms(pct(r.latencies, 50)), ms(pct(r.latencies, 90)), ms(pct(r.latencies, 99)),
		reqs/r.wall.Seconds(), r.errors, float64(r.appCPU.Milliseconds())*1000/reqs, gwCell)
}

func ms(d time.Duration) string { return fmt.Sprintf("%.2f ms", float64(d.Microseconds())/1000) }

func pct(ds []time.Duration, p int) time.Duration {
	if len(ds) == 0 {
		return 0
	}
	sorted := append([]time.Duration(nil), ds...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })
	i := (len(sorted)*p + 99) / 100
	if i > 0 {
		i--
	}
	return sorted[i]
}

// median picks the round with the median p50.
func median(rs []result) result {
	sorted := append([]result(nil), rs...)
	sort.Slice(sorted, func(i, j int) bool { return pct(sorted[i].latencies, 50) < pct(sorted[j].latencies, 50) })
	return sorted[len(sorted)/2]
}

func run(client *http.Client, base string, s scenario, n, concurrency, gwPid, appPid int) result {
	jobs := make(chan struct{}, n)
	for i := 0; i < n; i++ {
		jobs <- struct{}{}
	}
	close(jobs)
	var mu sync.Mutex
	res := result{}
	gw0, app0 := cpu(gwPid), cpu(appPid)
	start := time.Now()
	var wg sync.WaitGroup
	for w := 0; w < concurrency; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range jobs {
				t0 := time.Now()
				resp, err := client.Post(base+s.path, "application/json", bytes.NewReader(s.body))
				if err == nil {
					_, err = io.Copy(io.Discard, resp.Body)
					resp.Body.Close()
					if resp.StatusCode != 200 {
						err = fmt.Errorf("status %d", resp.StatusCode)
					}
				}
				d := time.Since(t0)
				mu.Lock()
				if err != nil {
					res.errors++
				} else {
					res.latencies = append(res.latencies, d)
				}
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	res.wall = time.Since(start)
	res.gwCPU, res.appCPU = cpu(gwPid)-gw0, cpu(appPid)-app0
	return res
}

// cpu is a process's user+system time from /proc/<pid>/stat (100 Hz ticks).
func cpu(pid int) time.Duration {
	if pid <= 0 {
		return 0
	}
	raw, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return 0
	}
	// Fields after the command name, which is in parentheses and may hold spaces.
	text := string(raw)
	fields := strings.Fields(text[strings.LastIndexByte(text, ')')+1:])
	if len(fields) < 13 {
		return 0
	}
	utime, _ := strconv.ParseInt(fields[11], 10, 64)
	stime, _ := strconv.ParseInt(fields[12], 10, 64)
	return time.Duration(utime+stime) * 10 * time.Millisecond
}
