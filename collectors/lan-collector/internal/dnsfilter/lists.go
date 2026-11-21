package dnsfilter

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Categories LAN Detective knows. Large public lists are downloaded and cached; the small,
// well-known service lists are built in.
var downloaded = map[string]string{
	// StevenBlack unified hosts: advertising + malware domains (MIT licence).
	"ads_malware": "https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts",
	"adult":       "https://raw.githubusercontent.com/StevenBlack/hosts/master/alternates/porn-only/hosts",
	"gambling":    "https://raw.githubusercontent.com/StevenBlack/hosts/master/alternates/gambling-only/hosts",
}

var builtin = map[string][]string{
	"social": {"facebook.com", "fbcdn.net", "facebook.net", "fb.com", "instagram.com", "cdninstagram.com", "tiktok.com", "tiktokcdn.com",
		"tiktokv.com", "tiktokcdn-us.com", "byteoversea.com", "ibytedtos.com", "musical.ly", "snapchat.com", "snapkit.com", "sc-cdn.net",
		"x.com", "twitter.com", "twimg.com", "t.co", "reddit.com", "redd.it", "redditmedia.com", "redditstatic.com", "pinterest.com",
		"pinimg.com", "threads.net", "tumblr.com", "likee.video", "bigo.tv"},
	"video": {"youtube.com", "youtu.be", "googlevideo.com", "ytimg.com", "youtube-nocookie.com", "youtubei.googleapis.com", "netflix.com",
		"nflxvideo.net", "nflximg.net", "nflxext.com", "nflxso.net", "twitch.tv", "ttvnw.net", "jtvnw.net", "disneyplus.com",
		"primevideo.com", "vimeo.com", "dailymotion.com", "shahid.net", "kick.com"},
	"games": {"roblox.com", "rbxcdn.com", "roblox.cn", "epicgames.com", "fortnite.com", "unrealengine.com", "steampowered.com",
		"steamcommunity.com", "steamstatic.com", "minecraft.net", "mojang.com", "xboxlive.com", "playstation.com", "playstation.net",
		"ea.com", "supercell.com", "riotgames.com", "leagueoflegends.com", "garena.com", "pubgmobile.com", "proximabeta.com",
		"igamecj.com", "activision.com", "callofduty.com", "miniclip.com"},
	"chat": {"whatsapp.com", "whatsapp.net", "telegram.org", "t.me", "telegram.me", "discord.com", "discord.gg", "discordapp.com",
		"discordapp.net", "discord.media", "messenger.com", "signal.org", "viber.com", "imo.im"},
	// Encrypted-DNS endpoints and the "canary" names browsers and phones check before bypassing
	// the network resolver. Blocking them keeps devices on the network's rules where possible.
	alwaysCategory: {"use-application-dns.net", "mask.icloud.com", "mask-h2.icloud.com", "dns.google", "cloudflare-dns.com",
		"one.one.one.one", "doh.opendns.com", "dns.quad9.net", "dns.adguard.com", "dns.adguard-dns.com", "doh.cleanbrowsing.org",
		"dns.nextdns.io", "doh.dns.sb", "dns.mullvad.net"},
}

// Known reports whether a category name exists.
func Known(category string) bool {
	_, d := downloaded[category]
	_, b := builtin[category]
	return d || b
}

// Lists holds the domain sets per category. Safe for concurrent use.
type Lists struct {
	mu   sync.RWMutex
	sets map[string]map[string]struct{}
	at   map[string]time.Time
}

func NewLists() *Lists {
	l := &Lists{sets: map[string]map[string]struct{}{}, at: map[string]time.Time{}}
	for c, domains := range builtin {
		set := make(map[string]struct{}, len(domains))
		for _, d := range domains {
			set[d] = struct{}{}
		}
		l.sets[c] = set
	}
	return l
}

func (l *Lists) Has(category, name string) bool {
	l.mu.RLock()
	set := l.sets[category]
	l.mu.RUnlock()
	return set != nil && matchSuffix(set, name)
}

// Counts reports how many domains each loaded category has.
func (l *Lists) Counts() map[string]int {
	l.mu.RLock()
	defer l.mu.RUnlock()
	out := map[string]int{}
	for c, s := range l.sets {
		out[c] = len(s)
	}
	return out
}

func (l *Lists) set(category string, set map[string]struct{}, at time.Time) {
	l.mu.Lock()
	l.sets[category] = set
	l.at[category] = at
	l.mu.Unlock()
}

// ParseHosts reads a hosts-format list ("0.0.0.0 example.com") or a plain one-domain-per-line list.
func ParseHosts(r io.Reader) map[string]struct{} {
	set := map[string]struct{}{}
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64*1024), 1024*1024)
	for sc.Scan() {
		line := sc.Text()
		if i := strings.IndexByte(line, '#'); i >= 0 {
			line = line[:i]
		}
		f := strings.Fields(line)
		var d string
		switch len(f) {
		case 1:
			d = f[0]
		case 0:
			continue
		default:
			d = f[1]
		}
		d = Normalize(d)
		if d == "" || !strings.Contains(d, ".") || d == "0.0.0.0" || strings.HasPrefix(d, "localhost") || strings.HasSuffix(d, ".local") ||
			d == "broadcasthost" || strings.Trim(d, "0123456789.") == "" {
			continue
		}
		set[d] = struct{}{}
	}
	return set
}

// Ensure makes the requested downloadable categories available: from the on-disk cache first,
// refreshed from the internet once a day. Failures leave the previous list in place.
func (l *Lists) Ensure(ctx context.Context, dir string, categories []string, client *http.Client) []error {
	var errs []error
	for _, c := range categories {
		url, ok := downloaded[c]
		if !ok {
			continue
		}
		path := filepath.Join(dir, c+".hosts")
		l.mu.RLock()
		_, loaded := l.sets[c]
		at := l.at[c]
		l.mu.RUnlock()
		if !loaded {
			if f, err := os.Open(path); err == nil {
				var modTime time.Time
				if st, err := f.Stat(); err == nil && st != nil {
					modTime = st.ModTime()
				}
				l.set(c, ParseHosts(f), modTime)
				f.Close()
				at = modTime
			}
		}
		if time.Since(at) < 24*time.Hour {
			continue
		}
		if err := download(ctx, client, url, path); err != nil {
			errs = append(errs, fmt.Errorf("%s list: %w", c, err))
			continue
		}
		if f, err := os.Open(path); err == nil {
			l.set(c, ParseHosts(f), time.Now())
			f.Close()
		}
	}
	return errs
}

func download(ctx context.Context, client *http.Client, url, path string) error {
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	resp, err := client.Do(req)
	if err != nil {
		return errors.New("download failed")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download returned HTTP %d", resp.StatusCode)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp := path + ".tmp"
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	_, err = io.Copy(f, io.LimitReader(resp.Body, 32<<20))
	f.Close()
	if err != nil {
		os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, path)
}
