package agent

// seenCommandsKept: how many command ids the agent remembers to run each command once. The server
// hands a command out once (it is marked delivered), so a repeat only comes from a retry of the
// same poll; remembering the last 8192 ids covers hours of remote desktop traffic.
const seenCommandsKept = 8192

// seenSet remembers the most recent command ids, oldest first out: a recent id is never forgotten
// to make room (the old map was cleared entirely at 2048 entries, so a command that had just run,
// a restart or a config restore, could run again if it was handed out again). EXT-4 in
// docs/security/review-2026-11.md. Not safe for concurrent use: the agent holds a.mu.
type seenSet struct {
	ids   map[string]struct{}
	order []string // ring buffer of the ids in ids, oldest at next
	next  int
}

func newSeenSet(capacity int) *seenSet {
	return &seenSet{ids: make(map[string]struct{}, capacity), order: make([]string, 0, capacity)}
}

// add records id and reports whether it was new.
func (s *seenSet) add(id string) bool {
	if _, ok := s.ids[id]; ok {
		return false
	}
	if len(s.order) < cap(s.order) {
		s.order = append(s.order, id)
	} else {
		delete(s.ids, s.order[s.next])
		s.order[s.next] = id
		s.next = (s.next + 1) % len(s.order)
	}
	s.ids[id] = struct{}{}
	return true
}
