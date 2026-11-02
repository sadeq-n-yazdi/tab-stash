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

// take reserves one try for the key. It returns false if the key has no
// tries left in this window. The reservation happens under the lock, so
// parallel requests cannot all pass before a failure is counted.
func (l *limiter) take(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	e := l.current(key)
	if e.fails >= l.max {
		return false
	}
	e.fails++
	return true
}

// refund gives back a try that take reserved (after a correct login).
func (l *limiter) refund(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if e := l.entries[key]; e != nil && e.fails > 0 {
		e.fails--
	}
}
