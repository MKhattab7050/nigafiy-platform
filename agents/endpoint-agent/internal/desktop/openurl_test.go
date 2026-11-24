package desktop

import "testing"

// Only plain http(s) addresses open (nothing is opened by this test).
func TestOpenURLRefusesAnythingButHTTP(t *testing.T) {
	for _, bad := range []string{"", "file:///C:/Windows/System32/calc.exe", "javascript:alert(1)", "ms-settings:privacy", "https://user:pw@it.example/x", "https:///nohost", "https://it.example/a b", `https://it.example/"&calc`} {
		if err := openURL(bad); err == nil {
			t.Fatalf("opened %q", bad)
		}
	}
	if _, _, err := (&Local{}).Tool(t.Context(), ToolRequest{Op: ToolOpenURL, URL: "file:///etc/passwd"}, nil); err == nil {
		t.Fatal("the tool opened a file URL")
	}
}
