package audio

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"math"
	"sync"
)

// ErrUnsupported: no loopback capture on this platform.
var ErrUnsupported = errors.New("remote audio is supported on Windows only (WASAPI loopback); Linux and macOS have no capture path without cgo")

// PacketMagic: binary socket packets of audio are 'N', 2 (frames are 'N', 1).
var PacketMagic = [2]byte{'N', 2}

// PacketMs is the length of one packet.
const PacketMs = 40

// Format of the samples the device delivers.
type Format struct {
	Rate     int
	Channels int
	Bits     int
	Float    bool
}

// Options for a capture.
type Options struct {
	// Mono mixes every channel into one (half the bandwidth).
	Mono bool
}

// Header is the JSON part of an audio packet.
type Header struct {
	T      string  `json:"t"` // "audio"
	Seq    uint64  `json:"seq"`
	Codec  string  `json:"codec"` // "ima_adpcm"
	Rate   int     `json:"rate"`
	Ch     int     `json:"ch"`
	Frames int     `json:"frames"`
	St     []State `json:"st"`
}

// Packet: magic (2) | header length uint32 BE | JSON header | ADPCM codes.
func (h Header) Packet(data []byte) []byte {
	js, _ := json.Marshal(h)
	out := make([]byte, 0, 6+len(js)+len(data))
	out = append(out, PacketMagic[:]...)
	out = binary.BigEndian.AppendUint32(out, uint32(len(js)))
	out = append(out, js...)
	return append(out, data...)
}

// ToInt16 converts raw device samples to interleaved 16-bit samples, keeping at most two channels
// (stereo) or mixing them all into one (mono). Unknown formats return nil.
func ToInt16(raw []byte, f Format, mono bool) []int16 {
	bps := f.Bits / 8
	if f.Channels <= 0 || bps <= 0 {
		return nil
	}
	frames := len(raw) / (bps * f.Channels)
	outCh := min(2, f.Channels)
	if mono {
		outCh = 1
	}
	out := make([]int16, 0, frames*outCh)
	sample := func(off int) float64 {
		b := raw[off:]
		switch {
		case f.Float && f.Bits == 32:
			return float64(math.Float32frombits(binary.LittleEndian.Uint32(b)))
		case !f.Float && f.Bits == 16:
			return float64(int16(binary.LittleEndian.Uint16(b))) / 32768
		case !f.Float && f.Bits == 24:
			v := int32(b[0]) | int32(b[1])<<8 | int32(int8(b[2]))<<16
			return float64(v) / 8388608
		case !f.Float && f.Bits == 32:
			return float64(int32(binary.LittleEndian.Uint32(b))) / 2147483648
		}
		return 0
	}
	if !(f.Float && f.Bits == 32) && !(!f.Float && (f.Bits == 16 || f.Bits == 24 || f.Bits == 32)) {
		return nil
	}
	to16 := func(v float64) int16 {
		v = math.Max(-1, math.Min(1, v))
		return int16(math.Round(v * 32767))
	}
	for i := 0; i < frames; i++ {
		base := i * bps * f.Channels
		if mono {
			var sum float64
			for c := 0; c < f.Channels; c++ {
				sum += sample(base + c*bps)
			}
			out = append(out, to16(sum/float64(f.Channels)))
			continue
		}
		for c := 0; c < outCh; c++ {
			out = append(out, to16(sample(base+c*bps)))
		}
	}
	return out
}

// Packetizer turns a stream of 16-bit samples into PacketMs-long ADPCM packets.
type Packetizer struct {
	mu      sync.Mutex
	rate    int
	ch      int
	st      []State
	pending []int16
	seq     uint64
	emit    func(Header, []byte)
}

func NewPacketizer(rate, channels int, emit func(Header, []byte)) *Packetizer {
	return &Packetizer{rate: rate, ch: channels, st: make([]State, channels), emit: emit}
}

// Write adds samples and emits every complete packet.
func (p *Packetizer) Write(samples []int16) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.pending = append(p.pending, samples...)
	per := p.rate * PacketMs / 1000 * p.ch
	for per > 0 && len(p.pending) >= per {
		chunk := p.pending[:per]
		start, data := Encode(p.st, chunk)
		p.seq++
		p.emit(Header{T: "audio", Seq: p.seq, Codec: "ima_adpcm", Rate: p.rate, Ch: p.ch, Frames: per / p.ch, St: start}, data)
		p.pending = append(p.pending[:0], p.pending[per:]...)
	}
}

// Capture is a running loopback capture.
type Capture interface {
	Stop()
	Format() Format
}

// Start captures what this computer plays and calls onPacket with each encoded packet (header and
// codes) until Stop.
func Start(opts Options, onPacket func(Header, []byte)) (Capture, error) {
	return start(opts, onPacket)
}
