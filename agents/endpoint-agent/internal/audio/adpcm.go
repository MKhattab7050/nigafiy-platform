// Package audio captures what the remote computer plays (WASAPI loopback on Windows) and encodes it
// for the live session socket (Fleet Pro remote audio, the "audio" permission; off unless the
// session's profile allows it and the operator turns it on).
//
// Codec: IMA ADPCM, 4 bits per sample, each packet decodable on its own (its header carries the
// predictor and step index of every channel). Opus would need about a quarter of the bandwidth, but
// no maintained pure-Go Opus *encoder* exists (pion/opus decodes only; the bindings need cgo, which
// this toolchain does not have). Measured bandwidth: 48 kHz stereo = 384 kbit/s, mono = 192 kbit/s
// (plus a ~100-byte header per 40 ms packet).
package audio

// IMA ADPCM tables (Interactive Multimedia Association recommendation, 1992).
var stepTable = [89]int32{
	7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118,
	130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060,
	1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484,
	7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
}

var indexTable = [16]int32{-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8}

// State is one channel's codec state.
type State struct {
	Predictor int32 `json:"p"`
	Index     int32 `json:"i"`
}

func clamp(v, lo, hi int32) int32 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// encodeSample returns the 4-bit code for one sample and advances the state.
func (s *State) encodeSample(sample int16) byte {
	step := stepTable[s.Index]
	diff := int32(sample) - s.Predictor
	var code byte
	if diff < 0 {
		code = 8
		diff = -diff
	}
	delta := step >> 3
	if diff >= step {
		code |= 4
		diff -= step
		delta += step
	}
	step >>= 1
	if diff >= step {
		code |= 2
		diff -= step
		delta += step
	}
	step >>= 1
	if diff >= step {
		code |= 1
		delta += step
	}
	if code&8 != 0 {
		s.Predictor -= delta
	} else {
		s.Predictor += delta
	}
	s.Predictor = clamp(s.Predictor, -32768, 32767)
	s.Index = clamp(s.Index+indexTable[code], 0, 88)
	return code
}

// DecodeSample turns one 4-bit code into a sample and advances the state.
func (s *State) DecodeSample(code byte) int16 {
	step := stepTable[s.Index]
	delta := step >> 3
	if code&4 != 0 {
		delta += step
	}
	if code&2 != 0 {
		delta += step >> 1
	}
	if code&1 != 0 {
		delta += step >> 2
	}
	if code&8 != 0 {
		s.Predictor -= delta
	} else {
		s.Predictor += delta
	}
	s.Predictor = clamp(s.Predictor, -32768, 32767)
	s.Index = clamp(s.Index+indexTable[code&15], 0, 88)
	return int16(s.Predictor)
}

// Encode encodes interleaved 16-bit samples (frames × channels). It returns the start state of each
// channel (what the decoder needs) and the codes, two per byte, low nibble first, interleaved like
// the input.
func Encode(st []State, samples []int16) (start []State, data []byte) {
	start = append([]State(nil), st...)
	data = make([]byte, (len(samples)+1)/2)
	ch := len(st)
	for i, v := range samples {
		code := st[i%ch].encodeSample(v)
		if i%2 == 0 {
			data[i/2] = code
		} else {
			data[i/2] |= code << 4
		}
	}
	return start, data
}

// Decode reverses Encode for n interleaved samples.
func Decode(start []State, data []byte, n int) []int16 {
	st := append([]State(nil), start...)
	out := make([]int16, n)
	ch := len(st)
	for i := 0; i < n && i/2 < len(data); i++ {
		code := data[i/2]
		if i%2 == 1 {
			code >>= 4
		}
		out[i] = st[i%ch].DecodeSample(code & 15)
	}
	return out
}
