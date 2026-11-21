package configbackup

import (
	"regexp"
	"sort"
	"strings"
)

// Evidence is one observation that points at a driver. Detail is device-supplied text, clipped.
type Evidence struct {
	Source string `json:"source"` // server_version | banner | prompt | probe | oui_vendor | sys_descr | previous | override
	Driver string `json:"driver,omitempty"`
	Detail string `json:"detail"`
	Weight int    `json:"weight"`
}

// Detection is the outcome of vendor auto-detection: the chosen driver, how sure we are, and why.
type Detection struct {
	Driver     string     `json:"driver"`
	Confidence string     `json:"confidence"` // high | medium | low | manual
	Evidence   []Evidence `json:"evidence"`
	Prompt     string     `json:"prompt,omitempty"`
	Family     string     `json:"prompt_family,omitempty"`
}

// Weights. A probe answer or a vendor-unique SSH identification is definitive; a banner can be an
// administrator's free text; a prompt only narrows the family; database hints are second-hand.
const (
	wProbe         = 100
	wServerVersion = 80
	wBanner        = 40
	wSysDescr      = 30
	wFamily        = 20
	wOUI           = 15
	wPrevious      = 10
	definitive     = 80
)

type detector struct {
	evidence []Evidence
}

func (d *detector) add(source, driver, detail string, weight int) {
	d.evidence = append(d.evidence, Evidence{Source: source, Driver: driver, Detail: clip(detail, 200), Weight: weight})
}

// SSH identification strings that name the vendor. "ROSSSH" and "HUAWEI" are unique to one CLI;
// "Cisco-1.x" is shared by IOS and ASA, so it only narrows.
var versionHints = []struct {
	re      *regexp.Regexp
	drivers []string
	weight  int
}{
	{regexp.MustCompile(`(?i)^SSH-[\d.]+-ROSSSH`), []string{"mikrotik_routeros"}, wServerVersion},
	{regexp.MustCompile(`(?i)^SSH-[\d.]+-HUAWEI`), []string{"huawei_vrp"}, wServerVersion},
	{regexp.MustCompile(`(?i)^SSH-[\d.]+-Cisco-`), []string{"cisco_ios", "cisco_asa"}, wBanner},
}

func (d *detector) serverVersion(v string) {
	for _, h := range versionHints {
		if h.re.MatchString(v) {
			for _, id := range h.drivers {
				d.add("server_version", id, v, h.weight)
			}
		}
	}
}

func (d *detector) text(source, text string, weight int) {
	for _, dr := range drivers {
		if dr.Text != nil {
			if m := dr.Text.FindString(text); m != "" {
				d.add(source, dr.ID, m, weight)
			}
		}
	}
}

func (d *detector) family(prompt, family string) {
	if family == "" {
		return
	}
	for _, dr := range drivers {
		if dr.Family == family {
			d.add("prompt", dr.ID, prompt, wFamily)
		}
	}
}

func (d *detector) hints(h Hints) {
	if h.OUIVendor != "" {
		for _, dr := range drivers {
			if dr.OUIVendor != nil && dr.OUIVendor.MatchString(h.OUIVendor) {
				d.add("oui_vendor", dr.ID, h.OUIVendor, wOUI)
			}
		}
	}
	if h.SysDescr != "" {
		for _, dr := range drivers {
			if dr.SysDescr != nil && dr.SysDescr.MatchString(h.SysDescr) {
				d.add("sys_descr", dr.ID, h.SysDescr, wSysDescr)
			}
		}
	}
	if h.Driver != "" && DriverByID(h.Driver) != nil {
		d.add("previous", h.Driver, "detected on an earlier backup", wPrevious)
	}
}

type score struct {
	driver string
	total  int
	best   int
}

// scores sums the evidence per driver. A driver contradicted by the prompt family (the device's
// prompt belongs to another family) is dropped, so a stale database hint cannot win against what
// the device itself shows.
func (d *detector) scores(family string) []score {
	m := map[string]*score{}
	for _, e := range d.evidence {
		if e.Driver == "" {
			continue
		}
		if family != "" {
			if dr := DriverByID(e.Driver); dr != nil && dr.Family != family {
				continue
			}
		}
		s := m[e.Driver]
		if s == nil {
			s = &score{driver: e.Driver}
			m[e.Driver] = s
		}
		s.total += e.Weight
		if e.Weight > s.best {
			s.best = e.Weight
		}
	}
	out := make([]score, 0, len(m))
	for _, s := range m {
		out = append(out, *s)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].best != out[j].best {
			return out[i].best > out[j].best
		}
		if out[i].total != out[j].total {
			return out[i].total > out[j].total
		}
		return driverIndex(out[i].driver) < driverIndex(out[j].driver)
	})
	return out
}

func driverIndex(id string) int {
	for i, d := range drivers {
		if d.ID == id {
			return i
		}
	}
	return len(drivers)
}

// decided reports whether one driver is definitively identified (and unambiguous).
func (d *detector) decided(family string) (string, bool) {
	s := d.scores(family)
	if len(s) == 0 || s[0].best < definitive {
		return "", false
	}
	if len(s) > 1 && s[1].best >= definitive && s[1].total == s[0].total {
		return "", false
	}
	return s[0].driver, true
}

// result picks the driver with the strongest evidence and labels the confidence honestly.
func (d *detector) result(prompt, family string) (Detection, bool) {
	det := Detection{Evidence: d.evidence, Prompt: clip(prompt, 120), Family: family}
	s := d.scores(family)
	if len(s) == 0 {
		return det, false
	}
	top := s[0]
	if len(s) > 1 && s[1].best == top.best && s[1].total == top.total && top.best < definitive {
		return det, false // a tie between drivers with no definitive evidence: do not guess
	}
	det.Driver = top.driver
	switch {
	case top.best >= definitive:
		det.Confidence = "high"
	case top.total >= wBanner:
		det.Confidence = "medium"
	default:
		det.Confidence = "low"
	}
	return det, top.best >= wFamily
}

func clip(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) <= n {
		return s
	}
	return s[:n]
}
