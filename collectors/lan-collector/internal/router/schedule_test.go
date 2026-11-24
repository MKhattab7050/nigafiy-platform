package router

import (
	"errors"
	"reflect"
	"testing"
	"time"
)

func TestSplitWindows(t *testing.T) {
	all := []time.Weekday{0, 1, 2, 3, 4, 5, 6}
	cases := []struct {
		name string
		in   []Window
		want []Segment
	}{
		{"same day", []Window{{Days: []time.Weekday{1, 1, 3}, Start: "08:00", End: "17:30"}},
			[]Segment{{Days: []time.Weekday{1, 3}, Start: "08:00", End: "17:30"}}},
		{"overnight", []Window{{Days: []time.Weekday{5, 6}, Start: "22:00", End: "06:00"}},
			[]Segment{{Days: []time.Weekday{5, 6}, Start: "22:00", End: EndOfDay}, {Days: []time.Weekday{0, 6}, Start: "00:00", End: "06:00"}}},
		{"overnight to midnight", []Window{{Days: []time.Weekday{2}, Start: "21:00", End: "00:00"}},
			[]Segment{{Days: []time.Weekday{2}, Start: "21:00", End: EndOfDay}}},
		{"all days all day", []Window{{Days: all, Start: "00:00", End: "00:00"}},
			[]Segment{{Days: all, Start: "00:00", End: EndOfDay}}},
		{"24h from noon", []Window{{Days: []time.Weekday{6}, Start: "12:00", End: "12:00"}},
			[]Segment{{Days: []time.Weekday{6}, Start: "12:00", End: EndOfDay}, {Days: []time.Weekday{0}, Start: "00:00", End: "12:00"}}},
		{"merged", []Window{{Days: []time.Weekday{1}, Start: "08:00", End: "09:00"}, {Days: []time.Weekday{2}, Start: "08:00", End: "09:00"}},
			[]Segment{{Days: []time.Weekday{1, 2}, Start: "08:00", End: "09:00"}}},
	}
	for _, c := range cases {
		got, err := SplitWindows(c.in)
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: got %+v want %+v", c.name, got, c.want)
		}
	}
	if !(Segment{Start: "00:00", End: EndOfDay}).AllDay() {
		t.Error("AllDay")
	}
}

func TestValidateWindowsAndLimit(t *testing.T) {
	bad := [][]Window{
		nil,
		{{Days: nil, Start: "08:00", End: "09:00"}},
		{{Days: []time.Weekday{7}, Start: "08:00", End: "09:00"}},
		{{Days: []time.Weekday{1}, Start: "8:00", End: "09:00"}},
		{{Days: []time.Weekday{1}, Start: "08:00", End: "24:00"}},
		{{Days: []time.Weekday{1}, Start: "08:00", End: "09:60"}},
		make([]Window, MaxWindows+1),
	}
	for i, ws := range bad {
		if _, err := SplitWindows(ws); !errors.Is(err, ErrInvalidArgument) {
			t.Errorf("case %d: want invalid argument, got %v", i, err)
		}
	}
	for _, l := range []RateLimit{{}, {DownKbps: -1, UpKbps: 5}, {DownKbps: MaxRateKbps + 1}} {
		if err := ValidateRateLimit(l); !errors.Is(err, ErrInvalidArgument) {
			t.Errorf("%+v: want invalid argument, got %v", l, err)
		}
	}
	if err := ValidateRateLimit(RateLimit{UpKbps: 1}); err != nil {
		t.Error(err)
	}
	if got := DescribeLimit(RateLimit{DownKbps: 2000}); got != "down 2000 kbit/s, up no limit" {
		t.Error(got)
	}
	if got := DescribeWindows([]Window{{Days: []time.Weekday{1, 2}, Start: "22:00", End: "06:00"}}); got != "Mon,Tue 22:00-06:00" {
		t.Error(got)
	}
}
