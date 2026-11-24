package audio

import (
	"encoding/binary"
	"encoding/json"
	"math"
	"os"
	"runtime"
	"testing"
	"time"
)

func sine(n, rate int, hz float64, amp float64) []int16 {
	out := make([]int16, n)
	for i := range out {
		out[i] = int16(amp * math.Sin(2*math.Pi*hz*float64(i)/float64(rate)))
	}
	return out
}

// The codec keeps speech-band audio intelligible: signal-to-noise above 20 dB on a 1 kHz tone.
func TestADPCMRoundTripQuality(t *testing.T) {
	in := sine(4800, 48000, 1000, 12000)
	start, data := Encode(make([]State, 1), in)
	if len(data) != len(in)/2 {
		t.Fatalf("%d samples took %d bytes", len(in), len(data))
	}
	out := Decode(start, data, len(in))
	var sig, noise float64
	for i := range in {
		sig += float64(in[i]) * float64(in[i])
		d := float64(in[i]) - float64(out[i])
		noise += d * d
	}
	snr := 10 * math.Log10(sig/noise)
	if snr < 20 {
		t.Fatalf("SNR %.1f dB", snr)
	}
}

// Packets are decodable on their own: the header carries each channel's state.
func TestPacketizerIndependentPackets(t *testing.T) {
	var headers []Header
	var datas [][]byte
	p := NewPacketizer(48000, 2, func(h Header, d []byte) { headers = append(headers, h); datas = append(datas, d) })
	stereo := make([]int16, 0, 48000*2/10)
	tone := sine(4800, 48000, 440, 8000)
	for _, v := range tone {
		stereo = append(stereo, v, -v)
	}
	p.Write(stereo)
	if len(headers) != 2 { // 100 ms → two 40 ms packets, 20 ms pending
		t.Fatalf("%d packets", len(headers))
	}
	h := headers[1]
	if h.Frames != 1920 || h.Ch != 2 || h.Rate != 48000 || h.Seq != 2 || len(datas[1]) != 1920 {
		t.Fatalf("header %+v, %d bytes", h, len(datas[1]))
	}
	out := Decode(h.St, datas[1], h.Frames*h.Ch)
	// Second packet starts at frame 1920: compare a sample well inside it.
	if d := math.Abs(float64(out[200]) - float64(stereo[1920*2+200])); d > 1500 {
		t.Fatalf("second packet decoded alone is off by %.0f", d)
	}
	// Measured bandwidth of the codec at 48 kHz stereo: 4 bits per sample.
	kbps := float64(len(datas[1])+100) * 8 / (PacketMs / 1000.0) / 1000
	if kbps < 384 || kbps > 410 {
		t.Fatalf("%.0f kbit/s", kbps)
	}
}

func TestToInt16Formats(t *testing.T) {
	f32 := make([]byte, 8)
	binary.LittleEndian.PutUint32(f32[0:], math.Float32bits(0.5))
	binary.LittleEndian.PutUint32(f32[4:], math.Float32bits(-1))
	if got := ToInt16(f32, Format{Rate: 48000, Channels: 2, Bits: 32, Float: true}, false); len(got) != 2 || got[0] != 16384 || got[1] != -32767 {
		t.Fatalf("float: %v", got)
	}
	if got := ToInt16(f32, Format{Rate: 48000, Channels: 2, Bits: 32, Float: true}, true); len(got) != 1 || got[0] != -8192 {
		t.Fatalf("mono: %v", got)
	}
	// 6 channels keep the first two in stereo.
	six := make([]byte, 12)
	binary.LittleEndian.PutUint16(six[0:], 1000)
	binary.LittleEndian.PutUint16(six[2:], 2000)
	if got := ToInt16(six, Format{Rate: 44100, Channels: 6, Bits: 16}, false); len(got) != 2 || got[0] != 1000 || got[1] != 2000 {
		t.Fatalf("5.1: %v", got)
	}
	if ToInt16(six, Format{Channels: 2, Bits: 8}, false) != nil {
		t.Fatal("8-bit accepted")
	}
}

func TestPacketLayout(t *testing.T) {
	b := Header{T: "audio", Seq: 1, Codec: "ima_adpcm", Rate: 48000, Ch: 1, Frames: 2, St: []State{{}}}.Packet([]byte{0x12})
	if b[0] != 'N' || b[1] != 2 {
		t.Fatal("magic")
	}
	n := binary.BigEndian.Uint32(b[2:6])
	var h Header
	if err := json.Unmarshal(b[6:6+n], &h); err != nil || h.T != "audio" || b[len(b)-1] != 0x12 {
		t.Fatalf("%v %+v", err, h)
	}
}

// Captures this computer's playback for half a second (opt-in: it opens the real audio device).
func TestRealLoopbackCapture(t *testing.T) {
	if runtime.GOOS != "windows" {
		if _, err := Start(Options{}, nil); err != ErrUnsupported {
			t.Fatalf("expected ErrUnsupported, got %v", err)
		}
		return
	}
	if os.Getenv("NIGAFIY_AUDIO_TEST") != "1" {
		t.Skip("set NIGAFIY_AUDIO_TEST=1 to open the real playback device in loopback")
	}
	c, err := Start(Options{}, func(Header, []byte) {})
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(500 * time.Millisecond)
	f := c.Format()
	c.Stop()
	if f.Rate <= 0 || f.Channels <= 0 {
		t.Fatalf("format %+v", f)
	}
	t.Logf("device mix format: %+v", f)
}
