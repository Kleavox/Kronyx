package stream

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/Kleavox/krynodes/agent/internal/reporter"
)

const (
	minBackoff   = time.Minute
	maxBackoff   = 30 * time.Minute
	replyTimeout = 30 * time.Second
	keepalive    = 50 * time.Second
)

var ErrNotConnected = errors.New("no live connection")

type Streamer struct {
	endpoint string
	token    string
	version  string
	now      func() time.Time

	mu      sync.Mutex
	conn    *conn
	replies chan []byte
	pokes   chan struct{}
	retryAt time.Time
	backoff time.Duration
	closed  bool
}

func New(endpoint, token, version string) *Streamer {
	return &Streamer{
		endpoint: endpoint,
		token:    token,
		version:  version,
		now:      time.Now,
		pokes:    make(chan struct{}, 1),
	}
}

func (s *Streamer) Pokes() <-chan struct{} {
	return s.pokes
}

func (s *Streamer) ensure(ctx context.Context) (*conn, chan []byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil, nil, ErrNotConnected
	}
	if s.conn != nil {
		return s.conn, s.replies, nil
	}
	if s.now().Before(s.retryAt) {
		return nil, nil, ErrNotConnected
	}
	c, err := dial(ctx, s.endpoint, s.token, s.version)
	if err != nil {
		switch {
		case errors.Is(err, ErrStreamOff):
			s.backoff = maxBackoff
		case s.backoff == 0:
			s.backoff = minBackoff
		default:
			s.backoff = min(2*s.backoff, maxBackoff)
		}
		s.retryAt = s.now().Add(s.backoff)
		return nil, nil, fmt.Errorf("%w: %v", ErrNotConnected, err)
	}
	s.backoff = 0
	s.retryAt = time.Time{}
	s.conn = c
	s.replies = make(chan []byte, 4)
	go s.read(c, s.replies)
	go s.keepAlive(c)
	return c, s.replies, nil
}

func (s *Streamer) drop(c *conn) {
	s.mu.Lock()
	if s.conn == c {
		s.conn = nil
	}
	s.mu.Unlock()
	c.close()
}

func (s *Streamer) read(c *conn, replies chan []byte) {
	defer close(replies)
	defer s.drop(c)
	for {
		message, err := c.readMessage()
		if err != nil {
			return
		}
		var envelope struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(message, &envelope) != nil {
			continue
		}
		switch envelope.Type {
		case "poke":
			select {
			case s.pokes <- struct{}{}:
			default:
			}
		case "heartbeat", "error":
			select {
			case replies <- message:
			default:
			}
		}
	}
}

func (s *Streamer) keepAlive(c *conn) {
	ticker := time.NewTicker(keepalive)
	defer ticker.Stop()
	for range ticker.C {
		s.mu.Lock()
		current := s.conn == c
		s.mu.Unlock()
		if !current {
			return
		}
		if err := c.write(opText, []byte("ping")); err != nil {
			s.drop(c)
			return
		}
	}
}

func (s *Streamer) SendHeartbeat(ctx context.Context, beat reporter.Heartbeat) (reporter.HeartbeatResponse, error) {
	c, replies, err := s.ensure(ctx)
	if err != nil {
		return reporter.HeartbeatResponse{}, err
	}
	for drained := false; !drained; {
		select {
		case <-replies:
		default:
			drained = true
		}
	}
	payload, err := json.Marshal(struct {
		Type      string             `json:"type"`
		Heartbeat reporter.Heartbeat `json:"heartbeat"`
	}{"heartbeat", beat})
	if err != nil {
		return reporter.HeartbeatResponse{}, err
	}
	if err := c.write(opText, payload); err != nil {
		s.drop(c)
		return reporter.HeartbeatResponse{}, fmt.Errorf("send over the live connection: %w", err)
	}
	timer := time.NewTimer(replyTimeout)
	defer timer.Stop()
	select {
	case message, ok := <-replies:
		if !ok {
			return reporter.HeartbeatResponse{}, errors.New("the live connection closed")
		}
		var answer struct {
			Type     string                     `json:"type"`
			Code     string                     `json:"code"`
			Response reporter.HeartbeatResponse `json:"response"`
		}
		if err := json.Unmarshal(message, &answer); err != nil {
			return reporter.HeartbeatResponse{}, fmt.Errorf("read the live reply: %w", err)
		}
		if answer.Type != "heartbeat" {
			return reporter.HeartbeatResponse{}, fmt.Errorf("the live connection refused the heartbeat: %s", answer.Code)
		}
		return answer.Response, nil
	case <-timer.C:
		s.drop(c)
		return reporter.HeartbeatResponse{}, errors.New("the live connection did not answer")
	case <-ctx.Done():
		return reporter.HeartbeatResponse{}, ctx.Err()
	}
}

func (s *Streamer) Close() {
	s.mu.Lock()
	s.closed = true
	c := s.conn
	s.conn = nil
	s.mu.Unlock()
	if c != nil {
		c.close()
	}
}

type HTTPReporter interface {
	SendHeartbeat(context.Context, reporter.Heartbeat) (reporter.HeartbeatResponse, error)
	FetchConfig(context.Context) (reporter.AgentConfig, error)
}

type Hybrid struct {
	Stream *Streamer
	HTTP   HTTPReporter
}

func (h Hybrid) SendHeartbeat(ctx context.Context, beat reporter.Heartbeat) (reporter.HeartbeatResponse, error) {
	if h.Stream != nil {
		response, err := h.Stream.SendHeartbeat(ctx, beat)
		if err == nil {
			return response, nil
		}
		if !errors.Is(err, ErrNotConnected) {
			log.Printf("live connection failed, reporting over HTTP: %v", err)
		}
	}
	return h.HTTP.SendHeartbeat(ctx, beat)
}

func (h Hybrid) FetchConfig(ctx context.Context) (reporter.AgentConfig, error) {
	return h.HTTP.FetchConfig(ctx)
}
