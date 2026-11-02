package api

import (
	"sync"
	"time"
)

// limiter allows `max` failed tries for each key (IP address) in a fixed
// time window. Old entries are removed, so the map cannot grow without limit.
type limiter struct {
	mu        sync.Mutex
	max       int
	window    time.Duration
	entries   map[string]*window
	lastSweep time.Time
	now       func() time.Time
}

type window struct {
	start time.Time
	fails int
}

func newLimiter(max int, w time.Duration) *limiter {
	return &limiter{max: max, window: w, entries: map[string]*window{}, now: time.Now}
}

func (l *limiter) current(key string) *window {
	now := l.now()
	if now.Sub(l.lastSweep) > l.window {
		for k, e := range l.entries {
			if now.Sub(e.start) >= l.window {
				delete(l.entries, k)
			}
		}
		l.lastSweep = now
	}
	e := l.entries[key]
	if e == nil || now.Sub(e.start) >= l.window {
		e = &window{start: now}
		l.entries[key] = e
	}
	return e
}

// allow reports whether the key can try again.
func (l *limiter) allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.current(key).fails < l.max
}

// fail records a failed try.
func (l *limiter) fail(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.current(key).fails++
}
