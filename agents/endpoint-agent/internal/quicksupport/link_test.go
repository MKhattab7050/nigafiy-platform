package quicksupport

import (
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

// linkFor turns a trailer into the Fleet link, as the API's bindingLink does.
func linkFor(trailer []byte) string {
	return LinkPrefix + base64.RawURLEncoding.EncodeToString(trailerJSON(trailer))
}

func trailerJSON(trailer []byte) []byte {
	n := binary.LittleEndian.Uint32(trailer[len(trailer)-len(magic)-4:])
	return trailer[1 : 1+n]
}

func TestParseLinkVerifiesTheSameSignature(t *testing.T) {
	priv := newKey(t)
	trailer := signed(t, priv, "https://nigafiy.corp.test")
	link := linkFor(trailer)
	b, err := ParseLink(link)
	if err != nil {
		t.Fatal(err)
	}
	fromFile, err := ReadBinding(writeExe(t, trailer))
	if err != nil {
		t.Fatal(err)
	}
	if b.Server != "https://nigafiy.corp.test" || b.Fingerprint() != fromFile.Fingerprint() || b.Link != fromFile.Link {
		t.Fatalf("link binding %+v, file binding %+v", b, fromFile)
	}
	// Windows may hand the link over with a trailing slash, padding or another case of the scheme.
	for _, v := range []string{link + "/", " " + link + " ", "NIGAFIY-SUPPORT:qs1/" + link[len(LinkPrefix):], link + "=="} {
		if _, err := ParseLink(v); err != nil {
			t.Errorf("%q: %v", v[:24], err)
		}
	}
	// Another server's payload with this link's signature (a changed server) is refused.
	var good, evil map[string]string
	other := signed(t, priv, "https://evil.test")
	_ = json.Unmarshal(trailerJSON(trailer), &good)
	_ = json.Unmarshal(trailerJSON(other), &evil)
	mixed, _ := json.Marshal(map[string]string{"payload": evil["payload"], "sig": good["sig"]})
	if _, err := ParseLink(LinkPrefix + base64.RawURLEncoding.EncodeToString(mixed)); err == nil {
		t.Error("changed server accepted")
	}
	for _, bad := range []string{"", LinkPrefix, LinkPrefix + "!!!", "nigafiy-support:qs2/" + link[len(LinkPrefix):], "https://example.test/" + link, LinkPrefix + base64.RawURLEncoding.EncodeToString([]byte(`{"payload":"e30=","sig":"AA=="}`))} {
		if _, err := ParseLink(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}

func TestFromArgsPrefersTheLinkAndTheStoreVersionNeedsOne(t *testing.T) {
	priv := newKey(t)
	exe := writeExe(t, signed(t, priv, "https://file.corp.test"))
	link := linkFor(signed(t, priv, "https://link.corp.test"))
	if b, err := FromArgs([]string{link}, exe, false); err != nil || b.Server != "https://link.corp.test" {
		t.Fatalf("link wins: %+v %v", b, err)
	}
	if b, err := FromArgs(nil, exe, false); err != nil || b.Server != "https://file.corp.test" {
		t.Fatalf("downloaded program: %+v %v", b, err)
	}
	if _, err := FromArgs(nil, exe, true); !errors.Is(err, ErrNoLink) {
		t.Fatalf("Store version without a link: %v", err)
	}
	if b, err := FromArgs([]string{link}, exe, true); err != nil || b.Server != "https://link.corp.test" {
		t.Fatalf("Store version with a link: %+v %v", b, err)
	}
}

func TestTheStoreVersionDoesNotSayItRemovesItself(t *testing.T) {
	b, _ := ParseLink(linkFor(signed(t, newKey(t), "https://nigafiy.corp.test")))
	r := Registration{Code: "123456789", PIN: "4711", ExpiresAt: time.Now().Add(10 * time.Minute)}
	if s := ScreenTextFor(b, r, false); !strings.Contains(s, "removes itself") {
		t.Fatalf("download text: %s", s)
	}
	s := ScreenTextFor(b, r, true)
	if strings.Contains(s, "removes itself") || !strings.Contains(s, "Settings > Apps") || !strings.Contains(s, "123 456 789") {
		t.Fatalf("Store text: %s", s)
	}
	if ScreenText(b, r) != ScreenTextFor(b, r, false) {
		t.Fatal("ScreenText changed")
	}
}

func TestPackagedIsFalseForATestProcess(t *testing.T) {
	if Packaged() {
		t.Fatal("go test is not an MSIX package")
	}
}
