// Package logs writes the engine's own log and each child's output to size-rotated files, one line
// at a time, with collector and agent secrets redacted before anything reaches disk or a console.
package logs

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"time"
)

const (
	// DefaultMaxSize is the size at which a log file is rotated.
	DefaultMaxSize = 5 << 20
	// DefaultKeep is how many rotated files are kept next to the live one (<name>.1 … <name>.3).
	DefaultKeep = 3
	// maxLine caps a line without a newline so a child cannot grow the buffer without bound.
	maxLine = 64 << 10
)

// secretPattern matches the same token prefixes the desktop app redacts
// (apps/desktop/src/collector-manager.cjs): ldc_ collector credentials, lde_ enrollment tokens,
// ldea_ endpoint-agent enrollment tokens and lda_ endpoint-agent credentials.
var secretPattern = regexp.MustCompile(`ld(?:c|e|ea|a)_[A-Za-z0-9._-]{8,}`)

// ansiPattern matches terminal colour codes, which scripts/local.mjs prints.
var ansiPattern = regexp.MustCompile("\x1b\\[[0-9;]*[A-Za-z]")

// Redact replaces every token-like secret in s with "[redacted]".
func Redact(s string) string {
	return secretPattern.ReplaceAllString(s, "[redacted]")
}

// RotatingFile is an append-only file that is renamed to <path>.1 (and older files shifted up to
// <path>.<keep>) once it would grow past maxSize.
type RotatingFile struct {
	mu      sync.Mutex
	path    string
	maxSize int64
	keep    int
	f       *os.File
	size    int64
}

// OpenRotating opens (creating if needed) path for appending.
func OpenRotating(path string, maxSize int64, keep int) (*RotatingFile, error) {
	if maxSize <= 0 {
		maxSize = DefaultMaxSize
	}
	if keep < 1 {
		keep = 1
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	r := &RotatingFile{path: path, maxSize: maxSize, keep: keep}
	if err := r.open(); err != nil {
		return nil, err
	}
	return r, nil
}

func (r *RotatingFile) open() error {
	f, err := os.OpenFile(r.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	info, err := f.Stat()
	if err != nil {
		f.Close()
		return err
	}
	r.f = f
	r.size = info.Size()
	return nil
}

func (r *RotatingFile) rotate() error {
	if r.f != nil {
		r.f.Close()
		r.f = nil
	}
	os.Remove(fmt.Sprintf("%s.%d", r.path, r.keep))
	for i := r.keep - 1; i >= 1; i-- {
		os.Rename(fmt.Sprintf("%s.%d", r.path, i), fmt.Sprintf("%s.%d", r.path, i+1))
	}
	if err := os.Rename(r.path, r.path+".1"); err != nil && !os.IsNotExist(err) {
		return err
	}
	return r.open()
}

// Write appends p, rotating first when p would take the file past its size limit.
func (r *RotatingFile) Write(p []byte) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.f == nil {
		if err := r.open(); err != nil {
			return 0, err
		}
	}
	if r.size > 0 && r.size+int64(len(p)) > r.maxSize {
		if err := r.rotate(); err != nil {
			return 0, err
		}
	}
	n, err := r.f.Write(p)
	r.size += int64(n)
	return n, err
}

// Close closes the live file.
func (r *RotatingFile) Close() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.f == nil {
		return nil
	}
	err := r.f.Close()
	r.f = nil
	return err
}

// LineWriter splits whatever is written to it into lines, redacts secrets and terminal colour codes
// in each complete line and writes it, with a timestamp, to out. Redacting whole lines means a token
// split across two writes is still caught.
type LineWriter struct {
	mu  sync.Mutex
	out io.Writer
	buf []byte
	now func() time.Time
}

// NewLineWriter returns a LineWriter writing to out. now may be nil (time.Now).
func NewLineWriter(out io.Writer, now func() time.Time) *LineWriter {
	if now == nil {
		now = time.Now
	}
	return &LineWriter{out: out, now: now}
}

// Write buffers p and emits every complete line.
func (w *LineWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.buf = append(w.buf, p...)
	for {
		i := bytes.IndexByte(w.buf, '\n')
		if i < 0 {
			break
		}
		w.emit(w.buf[:i])
		w.buf = w.buf[i+1:]
	}
	if len(w.buf) > maxLine {
		w.emit(w.buf)
		w.buf = w.buf[:0]
	}
	if len(w.buf) == 0 {
		w.buf = nil
	}
	return len(p), nil
}

// Flush writes a trailing partial line, if any.
func (w *LineWriter) Flush() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if len(w.buf) > 0 {
		w.emit(w.buf)
		w.buf = nil
	}
}

func (w *LineWriter) emit(line []byte) {
	s := string(bytes.TrimRight(line, "\r"))
	s = ansiPattern.ReplaceAllString(s, "")
	if s == "" {
		return
	}
	s = Redact(s)
	fmt.Fprintf(w.out, "%s %s\n", w.now().Format("2006-01-02T15:04:05.000Z07:00"), s)
}
