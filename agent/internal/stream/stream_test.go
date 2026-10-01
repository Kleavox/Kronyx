package stream

import (
	"bufio"
	"context"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Kleavox/krynodes/agent/internal/reporter"
)

type peer struct {
	conn net.Conn
	rw   *bufio.ReadWriter
}

func (p *peer) read(t *testing.T) (byte, []byte) {
	t.Helper()
	header := make([]byte, 2)
	if _, err := io.ReadFull(p.rw, header); err != nil {
		t.Errorf("read header: %v", err)
		return 0, nil
	}
	if header[1]&0x80 == 0 {
		t.Errorf("client frame is not masked")
	}
	length := uint64(header[1] & 0x7f)
	switch length {
	case 126:
		extended := make([]byte, 2)
		io.ReadFull(p.rw, extended)
		length = uint64(binary.BigEndian.Uint16(extended))
	case 127:
		extended := make([]byte, 8)
		io.ReadFull(p.rw, extended)
		length = binary.BigEndian.Uint64(extended)
	}
	mask := make([]byte, 4)
	io.ReadFull(p.rw, mask)
	payload := make([]byte, length)
	io.ReadFull(p.rw, payload)
	for index := range payload {
		payload[index] ^= mask[index%4]
	}
	return header[0] & 0x0f, payload
}

func (p *peer) write(opcode byte, payload []byte, fin bool) {
	first := opcode
	if fin {
		first |= 0x80
	}
	frame := []byte{first}
	switch {
	case len(payload) < 126:
		frame = append(frame, byte(len(payload)))
	case len(payload) <= 0xffff:
		frame = append(frame, 126, byte(len(payload)>>8), byte(len(payload)))
	default:
		extended := make([]byte, 8)
		binary.BigEndian.PutUint64(extended, uint64(len(payload)))
		frame = append(append(frame, 127), extended...)
	}
	p.rw.Write(append(frame, payload...))
	p.rw.Flush()
}

func server(t *testing.T, status int, handle func(*peer)) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	var dials atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		dials.Add(1)
		if status != http.StatusSwitchingProtocols {
			w.WriteHeader(status)
			return
		}
		if r.URL.Path != "/api/agent/stream" || r.Header.Get("Authorization") != "Bearer token" ||
			!strings.EqualFold(r.Header.Get("Upgrade"), "websocket") || r.Header.Get("Sec-WebSocket-Version") != "13" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		sum := sha1.Sum([]byte(r.Header.Get("Sec-WebSocket-Key") + guid))
		conn, rw, err := w.(http.Hijacker).Hijack()
		if err != nil {
			t.Errorf("hijack: %v", err)
			return
		}
		rw.WriteString("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " +
			base64.StdEncoding.EncodeToString(sum[:]) + "\r\n\r\n")
		rw.Flush()
		go func() {
			defer conn.Close()
			handle(&peer{conn: conn, rw: rw})
		}()
	}))
	t.Cleanup(srv.Close)
	return srv, &dials
}

func connected(s *Streamer) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.conn != nil
}

func beat() reporter.Heartbeat {
	return reporter.Heartbeat{NodeID: "node-1", Host: reporter.Host{Hostname: "pivox", AgentVersion: "0.3.0"}}
}

func reply(p *peer, response string) {
	p.write(opText, []byte(`{"type":"heartbeat","response":`+response+`}`), true)
}

func TestHeartbeatRoundTrip(t *testing.T) {
	srv, _ := server(t, http.StatusSwitchingProtocols, func(p *peer) {
		opcode, payload := p.read(t)
		var message struct {
			Type      string          `json:"type"`
			Heartbeat json.RawMessage `json:"heartbeat"`
		}
		if err := json.Unmarshal(payload, &message); err != nil || opcode != opText || message.Type != "heartbeat" ||
			!strings.Contains(string(message.Heartbeat), `"nodeId":"node-1"`) {
			t.Errorf("unexpected message %d %s", opcode, payload)
		}
		reply(p, `{"ok":true,"intervalSeconds":60,"configVersion":"v1","refresh":true,"padding":"`+strings.Repeat("x", 300)+`"}`)
		p.read(t)
	})
	streamer := New(srv.URL, "token", "0.3.0")
	defer streamer.Close()
	response, err := streamer.SendHeartbeat(context.Background(), beat())
	if err != nil {
		t.Fatal(err)
	}
	if !response.OK || response.ConfigVersion != "v1" || !response.Refresh || response.IntervalSeconds != 60 {
		t.Fatalf("response %+v", response)
	}
}

func TestPokesArriveEvenInFragmentsAndPingsAreAnswered(t *testing.T) {
	pong := make(chan []byte, 1)
	srv, _ := server(t, http.StatusSwitchingProtocols, func(p *peer) {
		p.read(t)
		reply(p, `{"ok":true,"intervalSeconds":60,"configVersion":"v1"}`)
		p.write(opText, []byte(`{"type":`), false)
		p.write(opContinuation, []byte(`"poke"}`), true)
		p.write(opPing, []byte("hi"), true)
		opcode, payload := p.read(t)
		if opcode == opPong {
			pong <- payload
		}
		p.read(t)
	})
	streamer := New(srv.URL, "token", "0.3.0")
	defer streamer.Close()
	if _, err := streamer.SendHeartbeat(context.Background(), beat()); err != nil {
		t.Fatal(err)
	}
	select {
	case <-streamer.Pokes():
	case <-time.After(2 * time.Second):
		t.Fatal("no poke")
	}
	select {
	case payload := <-pong:
		if string(payload) != "hi" {
			t.Fatalf("pong %q", payload)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no pong")
	}
}

type fakeHTTP struct{ calls int }

func (f *fakeHTTP) SendHeartbeat(context.Context, reporter.Heartbeat) (reporter.HeartbeatResponse, error) {
	f.calls++
	return reporter.HeartbeatResponse{OK: true, ConfigVersion: "http"}, nil
}

func (f *fakeHTTP) FetchConfig(context.Context) (reporter.AgentConfig, error) {
	return reporter.AgentConfig{}, nil
}

func TestHybridFallsBackToHTTPWhenTheHubRefuses(t *testing.T) {
	srv, _ := server(t, http.StatusSwitchingProtocols, func(p *peer) {
		p.read(t)
		p.write(opText, []byte(`{"type":"error","code":"SERVER_ERROR"}`), true)
		p.read(t)
	})
	fallback := &fakeHTTP{}
	streamer := New(srv.URL, "token", "0.3.0")
	defer streamer.Close()
	hybrid := Hybrid{Stream: streamer, HTTP: fallback}
	response, err := hybrid.SendHeartbeat(context.Background(), beat())
	if err != nil || response.ConfigVersion != "http" || fallback.calls != 1 {
		t.Fatalf("response %+v err %v calls %d", response, err, fallback.calls)
	}
}

func TestStreamsOffWaitsHalfAnHourAndOtherFailuresBackOff(t *testing.T) {
	off, offDials := server(t, http.StatusNotFound, nil)
	now := time.Date(2026, 10, 1, 8, 0, 0, 0, time.UTC)
	streamer := New(off.URL, "token", "0.3.0")
	streamer.now = func() time.Time { return now }
	defer streamer.Close()
	if _, err := streamer.SendHeartbeat(context.Background(), beat()); !errors.Is(err, ErrNotConnected) {
		t.Fatalf("err %v", err)
	}
	now = now.Add(29 * time.Minute)
	streamer.SendHeartbeat(context.Background(), beat())
	if offDials.Load() != 1 {
		t.Fatalf("dialled %d times within 30 minutes", offDials.Load())
	}
	now = now.Add(2 * time.Minute)
	streamer.SendHeartbeat(context.Background(), beat())
	if offDials.Load() != 2 {
		t.Fatalf("dialled %d times after 30 minutes", offDials.Load())
	}

	broken, brokenDials := server(t, http.StatusUnauthorized, nil)
	retry := New(broken.URL, "token", "0.3.0")
	retry.now = func() time.Time { return now }
	defer retry.Close()
	retry.SendHeartbeat(context.Background(), beat())
	now = now.Add(59 * time.Second)
	retry.SendHeartbeat(context.Background(), beat())
	now = now.Add(2 * time.Second)
	retry.SendHeartbeat(context.Background(), beat())
	now = now.Add(61 * time.Second)
	retry.SendHeartbeat(context.Background(), beat())
	if brokenDials.Load() != 2 {
		t.Fatalf("dialled %d times; want a minute, then two minutes", brokenDials.Load())
	}
}

func TestAClosedConnectionIsDialledAgain(t *testing.T) {
	srv, dials := server(t, http.StatusSwitchingProtocols, func(p *peer) {
		p.read(t)
		reply(p, `{"ok":true,"intervalSeconds":60,"configVersion":"v1"}`)
		p.write(opClose, []byte{0x03, 0xe8}, true)
	})
	now := time.Date(2026, 10, 1, 8, 0, 0, 0, time.UTC)
	streamer := New(srv.URL, "token", "0.3.0")
	streamer.now = func() time.Time { return now }
	defer streamer.Close()
	if _, err := streamer.SendHeartbeat(context.Background(), beat()); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for connected(streamer) && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if connected(streamer) {
		t.Fatal("still connected after a close frame")
	}
	if _, err := streamer.SendHeartbeat(context.Background(), beat()); err != nil {
		t.Fatal(err)
	}
	if dials.Load() != 2 {
		t.Fatalf("dials %d", dials.Load())
	}
}

func TestTheHandshakeMustProveTheKey(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, rw, _ := w.(http.Hijacker).Hijack()
		rw.WriteString("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: wrong\r\n\r\n")
		rw.Flush()
		conn.Close()
	}))
	defer srv.Close()
	if _, err := dial(context.Background(), srv.URL, "token", "0.3.0"); err == nil || !strings.Contains(err.Error(), "accept") {
		t.Fatalf("err %v", err)
	}
}
