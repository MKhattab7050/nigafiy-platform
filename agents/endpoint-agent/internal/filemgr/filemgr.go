// Package filemgr implements an enterprise remote file manager for enrolled endpoints
// with strict path validation, protected-location guards, chunked resumable transfers,
// and batch file operations.
package filemgr

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	MaxChunkBytes  = 512 * 1024 // 512 KB per transfer chunk
	MaxListEntries = 1500
	MaxSearchHits  = 250
	MaxSearchDepth = 6
)

type RootEntry struct {
	Name  string `json:"name"`
	Path  string `json:"path"`
	Label string `json:"label"`
}

type FileEntry struct {
	Name     string `json:"name"`
	Path     string `json:"path"`
	IsDir    bool   `json:"is_dir"`
	Ext      string `json:"ext"`
	Size     int64  `json:"size"`
	Mode     string `json:"mode"`
	ModTime  string `json:"mod_time"`
	IsHidden bool   `json:"is_hidden"`
	IsSystem bool   `json:"is_system"`
}

type Request struct {
	Op                 string   `json:"op"` // roots | list | search | mkdir | touch | rename | copy | move | delete | download | upload | hash
	Path               string   `json:"path,omitempty"`
	Paths              []string `json:"paths,omitempty"`
	TargetPath         string   `json:"target_path,omitempty"`
	NewName            string   `json:"new_name,omitempty"`
	Query              string   `json:"query,omitempty"`
	ShowHidden         bool     `json:"show_hidden,omitempty"`
	ConfirmDestructive bool     `json:"confirm_destructive,omitempty"`
	Offset             int64    `json:"offset,omitempty"`
	Length             int64    `json:"length,omitempty"`
	Append             bool     `json:"append,omitempty"`
	DataBase64         string   `json:"data_base64,omitempty"`
	ExpectedSHA256     string   `json:"expected_sha256,omitempty"`
	AllowedRoots       []string `json:"allowed_roots,omitempty"`
	// Overwrite lets an upload replace an existing file. The operator confirms it in a dialog first;
	// without it an upload never touches a file that already exists.
	Overwrite bool `json:"overwrite,omitempty"`
}

type Response struct {
	Op         string      `json:"op"`
	Path       string      `json:"path,omitempty"`
	ParentPath string      `json:"parent_path,omitempty"`
	Roots      []RootEntry `json:"roots,omitempty"`
	Entries    []FileEntry `json:"entries,omitempty"`
	TotalSize  int64       `json:"total_size,omitempty"`
	Offset     int64       `json:"offset,omitempty"`
	BytesRead  int64       `json:"bytes_read,omitempty"`
	EOF        bool        `json:"eof,omitempty"`
	DataBase64 string      `json:"data_base64,omitempty"`
	SHA256     string      `json:"sha256,omitempty"`
	Message    string      `json:"message,omitempty"`
	// Overwritten is set when an upload replaced a file that already existed (with Overwrite).
	Overwritten bool `json:"overwritten,omitempty"`
	// UploadNext (hash only): an interrupted upload of this file that this agent started and can
	// still continue, and the offset its next chunk must start at (the file's size).
	UploadNext *int64 `json:"upload_next,omitempty"`
}

// ValidateAndCleanPath rejects traversal segments, null bytes, relative paths, and
// checks policy-configured allowed roots as well as protected credential/system paths.
func ValidateAndCleanPath(raw string, allowedRoots []string, mutating bool) (string, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", errors.New("path is required")
	}
	if strings.ContainsRune(trimmed, 0) {
		return "", errors.New("invalid null byte in path")
	}
	// Reject raw '..' path segments before cleaning to prevent subtle traversal tricks.
	normalized := strings.ReplaceAll(trimmed, `\`, `/`)
	for _, seg := range strings.Split(normalized, "/") {
		if seg == ".." {
			return "", errors.New("directory traversal (..) is not permitted")
		}
	}
	// Device namespaces (\\?\ and \\.\ prefixes) and UNC shares would let a request bypass the checks below or
	// reach other machines with the agent's own network identity.
	if strings.HasPrefix(normalized, "//") {
		return "", errors.New("network (UNC) and device paths are not permitted")
	}
	clean := filepath.Clean(trimmed)
	if !filepath.IsAbs(clean) {
		return "", errors.New("path must be absolute")
	}
	if err := checkGuards(clean, allowedRoots, mutating); err != nil {
		return "", err
	}
	// A symlink or junction inside an allowed folder must not lead outside it, or into a
	// protected location: check the real target too (for a new file, its parent folder).
	if real, ok := resolveExisting(clean); ok && real != clean {
		if strings.HasPrefix(filepath.ToSlash(real), "//") {
			return "", errors.New("path resolves to a network or device location")
		}
		// Roots are compared in their resolved form too (8.3 short names, linked folders).
		realRoots := make([]string, 0, len(allowedRoots))
		for _, r := range allowedRoots {
			if rr, ok := resolveExisting(filepath.Clean(strings.TrimSpace(r))); ok {
				realRoots = append(realRoots, rr)
			} else {
				realRoots = append(realRoots, r)
			}
		}
		if err := checkGuards(real, realRoots, mutating); err != nil {
			return "", fmt.Errorf("path resolves through a link: %w", err)
		}
	}
	return clean, nil
}

// guard is what an opened handle must still satisfy (EXT-8): the same policy roots and protected
// locations the path was checked against.
type guard struct {
	roots    []string
	mutating bool
}

// afterValidate runs between the path check and the open; tests use it to swap a folder for a
// link at exactly that moment.
var afterValidate = func(clean string) {}

func resolvedRoots(roots []string) []string {
	out := make([]string, 0, len(roots))
	for _, r := range roots {
		if rr, ok := resolveExisting(filepath.Clean(strings.TrimSpace(r))); ok {
			out = append(out, rr)
		} else {
			out = append(out, r)
		}
	}
	return out
}

// openChecked opens clean and keeps the handle only if the file it really reaches passes the
// guards (EXT-8). The path was checked before, but a folder on the way can be replaced by a link
// or junction between that check and the open (a local user racing the agent, which runs as
// LocalSystem / root); checking the handle closes that window for reads and writes. Nothing is
// truncated before the check (callers truncate through the checked handle), and an empty file this
// call created outside the guards is removed again.
func openChecked(clean string, flag int, perm fs.FileMode, g guard) (*os.File, error) {
	f, err := os.OpenFile(clean, flag, perm)
	if err != nil {
		return nil, err
	}
	real, err := openedPath(f)
	if err != nil {
		err = fmt.Errorf("cannot confirm where the opened file is: %w", err)
	} else if strings.HasPrefix(filepath.ToSlash(real), "//") {
		err = errors.New("path resolves to a network or device location")
	} else if gerr := checkGuards(real, resolvedRoots(g.roots), g.mutating); gerr != nil {
		err = fmt.Errorf("the opened file is not where the path was checked: %w", gerr)
	}
	if err == nil {
		return f, nil
	}
	var created fs.FileInfo
	if flag&os.O_EXCL != 0 {
		created, _ = f.Stat()
	}
	_ = f.Close()
	if created != nil && real != "" {
		if st, serr := os.Lstat(real); serr == nil && os.SameFile(st, created) && st.Size() == 0 {
			_ = os.Remove(real)
		}
	}
	return nil, err
}

// resolveExisting follows links in the longest existing prefix of p.
func resolveExisting(p string) (string, bool) {
	rest := ""
	cur := p
	for {
		if real, err := realPath(cur); err == nil {
			if rest == "" {
				return real, true
			}
			return filepath.Join(real, rest), true
		}
		parent := filepath.Dir(cur)
		if parent == cur {
			return "", false
		}
		rest = filepath.Join(filepath.Base(cur), rest)
		cur = parent
	}
}

func checkGuards(clean string, allowedRoots []string, mutating bool) error {
	if isForbiddenCredentialPath(clean) {
		return errors.New("access to protected credential or security store is forbidden")
	}
	if mutating && isProtectedSystemPath(clean) {
		return errors.New("modification or deletion of protected operating system path is forbidden")
	}
	if len(allowedRoots) > 0 {
		allowed := false
		for _, r := range allowedRoots {
			rc := filepath.Clean(strings.TrimSpace(r))
			if rc == "" {
				continue
			}
			if isSameOrSubpath(clean, rc) {
				allowed = true
				break
			}
		}
		if !allowed {
			return errors.New("path is outside the allowed management policy directories")
		}
	}
	return nil
}

// mustNotExist refuses to replace anything already at dst: copy, move and rename never overwrite
// (copying a file into its own folder would otherwise truncate it).
func mustNotExist(dst string) error {
	if _, err := os.Lstat(dst); err == nil {
		return fmt.Errorf("%s already exists at the destination", filepath.Base(dst))
	} else if !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}

func isSameOrSubpath(child, root string) bool {
	c := strings.ToLower(filepath.ToSlash(filepath.Clean(child)))
	r := strings.ToLower(filepath.ToSlash(filepath.Clean(root)))
	if c == r {
		return true
	}
	if !strings.HasSuffix(r, "/") {
		r += "/"
	}
	return strings.HasPrefix(c, r)
}

// Windows DPAPI master keys and Credential Manager / Vault stores, wherever the profile lives
// (C:/Users/<name>, C:/Windows/ServiceProfiles/..., the SYSTEM profile under System32).
var dpapiSegments = []string{
	"/appdata/roaming/microsoft/credentials",
	"/appdata/roaming/microsoft/protect",
	"/appdata/roaming/microsoft/vault",
	"/appdata/local/microsoft/credentials",
	"/appdata/local/microsoft/vault",
	"/programdata/microsoft/vault",
	"/system32/microsoft/protect",
}

// guardPath is the form the path guards compare: lower case, '/' separators. Backslashes count as
// separators on every OS (filepath.ToSlash converts them only on Windows), so a Windows-style path
// cannot slip past a guard elsewhere: stricter, never looser.
func guardPath(clean string) string {
	return strings.ToLower(strings.ReplaceAll(filepath.ToSlash(clean), `\`, "/"))
}

func isForbiddenCredentialPath(clean string) bool {
	lower := guardPath(clean)
	if strings.HasSuffix(lower, "/.ssh") || strings.Contains(lower, "/.ssh/") ||
		strings.HasSuffix(lower, "/credential.json") || lower == "credential.json" {
		return true
	}
	for _, seg := range dpapiSegments {
		if strings.HasSuffix(lower, seg) || strings.Contains(lower, seg+"/") {
			return true
		}
	}
	forbidden := []string{
		"/etc/shadow",
		"/etc/gshadow",
		"/etc/master.passwd",
		"/library/keychains",
		"/private/var/db/dslocal",
		"/root/.ssh",
		"/var/db/sudo",
	}
	for _, w := range windowsDirs() {
		forbidden = append(forbidden, w+"/system32/config") // SAM, SECURITY, SYSTEM hives and RegBack
	}
	for _, f := range forbidden {
		if lower == f || strings.HasPrefix(lower, f+"/") {
			return true
		}
	}
	return false
}

func isProtectedSystemPath(clean string) bool {
	lower := guardPath(clean)
	// Root drives / mount roots can never be deleted or overwritten directly.
	if lower == "/" || (len(lower) == 3 && lower[1] == ':' && lower[2] == '/') {
		return true
	}
	protected := []string{
		"c:/system volume information",
		"/boot",
		"/etc",
		"/proc",
		"/sys",
		"/dev",
		"/system",
		"/usr/bin",
		"/usr/sbin",
		"/bin",
		"/sbin",
	}
	for _, w := range windowsDirs() {
		protected = append(protected, w+"/system32", w+"/syswow64", w+"/winsxs", w+"/boot")
	}
	for _, p := range protected {
		if lower == p || strings.HasPrefix(lower, p+"/") {
			return true
		}
	}
	return false
}

// windowsDirs is the Windows directory (wherever it is installed) plus the usual C:\Windows.
func windowsDirs() []string {
	dirs := []string{"c:/windows"}
	if root := strings.TrimSpace(os.Getenv("SystemRoot")); root != "" {
		r := strings.TrimSuffix(strings.ToLower(filepath.ToSlash(filepath.Clean(root))), "/")
		if r != dirs[0] {
			dirs = append(dirs, r)
		}
	}
	return dirs
}

func Execute(req Request) (Response, error) {
	switch req.Op {
	case "roots":
		return Response{
			Op:    "roots",
			Roots: platformRoots(),
		}, nil

	case "list":
		target := req.Path
		if strings.TrimSpace(target) == "" {
			roots := platformRoots()
			if len(roots) == 0 {
				return Response{}, errors.New("no accessible storage roots")
			}
			target = roots[0].Path
		}
		clean, err := ValidateAndCleanPath(target, req.AllowedRoots, false)
		if err != nil {
			return Response{}, err
		}
		afterValidate(clean)
		return listDir(clean, req.ShowHidden, req.AllowedRoots)

	case "search":
		clean, err := ValidateAndCleanPath(req.Path, req.AllowedRoots, false)
		if err != nil {
			return Response{}, err
		}
		q := strings.ToLower(strings.TrimSpace(req.Query))
		if q == "" {
			return Response{}, errors.New("search query is required")
		}
		afterValidate(clean)
		hits, err := searchChecked(clean, q, req.ShowHidden, req.AllowedRoots)
		if err != nil {
			return Response{}, fmt.Errorf("search failed: %w", err)
		}
		return Response{Op: "search", Path: clean, Entries: hits}, nil

	case "mkdir":
		clean, err := ValidateAndCleanPath(req.Path, req.AllowedRoots, true)
		if err != nil {
			return Response{}, err
		}
		afterValidate(clean)
		if err := mkdirChecked(clean, guard{req.AllowedRoots, true}); err != nil {
			return Response{}, fmt.Errorf("mkdir failed: %w", err)
		}
		return Response{Op: "mkdir", Path: clean, Message: "Created folder " + filepath.Base(clean)}, nil

	case "touch":
		clean, err := ValidateAndCleanPath(req.Path, req.AllowedRoots, true)
		if err != nil {
			return Response{}, err
		}
		var content []byte
		if req.DataBase64 != "" {
			content, err = base64.StdEncoding.DecodeString(req.DataBase64)
			if err != nil {
				return Response{}, errors.New("invalid base64 file content")
			}
		}
		// Creates only: an existing file of the same name is never truncated (that is an upload).
		afterValidate(clean)
		f, err := openChecked(clean, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644, guard{req.AllowedRoots, true})
		if err != nil {
			if errors.Is(err, fs.ErrExist) {
				return Response{}, fmt.Errorf("%s already exists", filepath.Base(clean))
			}
			return Response{}, fmt.Errorf("create file failed: %w", err)
		}
		_, werr := f.Write(content)
		if cerr := f.Close(); werr == nil {
			werr = cerr
		}
		if werr != nil {
			return Response{}, fmt.Errorf("create file failed: %w", werr)
		}
		return Response{Op: "touch", Path: clean, Message: "Created file " + filepath.Base(clean)}, nil

	case "rename":
		clean, err := ValidateAndCleanPath(req.Path, req.AllowedRoots, true)
		if err != nil {
			return Response{}, err
		}
		newName := strings.TrimSpace(req.NewName)
		if newName == "" || strings.ContainsAny(newName, `/\`) || newName == "." || newName == ".." {
			return Response{}, errors.New("invalid new file name")
		}
		dest := filepath.Join(filepath.Dir(clean), newName)
		if _, err := ValidateAndCleanPath(dest, req.AllowedRoots, true); err != nil {
			return Response{}, err
		}
		if err := mustNotExist(dest); err != nil {
			return Response{}, err
		}
		afterValidate(clean)
		if err := renameChecked(clean, newName, guard{req.AllowedRoots, true}); err != nil {
			if errors.Is(err, fs.ErrExist) {
				return Response{}, fmt.Errorf("%s already exists at the destination", newName)
			}
			return Response{}, fmt.Errorf("rename failed: %w", err)
		}
		return Response{Op: "rename", Path: dest, Message: "Renamed to " + newName}, nil

	case "copy":
		destDir, err := ValidateAndCleanPath(req.TargetPath, req.AllowedRoots, true)
		if err != nil {
			return Response{}, err
		}
		sources := req.Paths
		if len(sources) == 0 && req.Path != "" {
			sources = []string{req.Path}
		}
		if len(sources) == 0 {
			return Response{}, errors.New("at least one source path is required")
		}
		for _, srcRaw := range sources {
			src, err := ValidateAndCleanPath(srcRaw, req.AllowedRoots, false)
			if err != nil {
				return Response{}, err
			}
			dst := filepath.Join(destDir, filepath.Base(src))
			if err := mustNotExist(dst); err != nil {
				return Response{}, err
			}
			afterValidate(src)
			if err := copyRecursive(src, dst, req.AllowedRoots); err != nil {
				return Response{}, fmt.Errorf("copy %s failed: %w", filepath.Base(src), err)
			}
		}
		return Response{Op: "copy", Path: destDir, Message: fmt.Sprintf("Copied %d item(s)", len(sources))}, nil

	case "move":
		destDir, err := ValidateAndCleanPath(req.TargetPath, req.AllowedRoots, true)
		if err != nil {
			return Response{}, err
		}
		sources := req.Paths
		if len(sources) == 0 && req.Path != "" {
			sources = []string{req.Path}
		}
		if len(sources) == 0 {
			return Response{}, errors.New("at least one source path is required")
		}
		for _, srcRaw := range sources {
			src, err := ValidateAndCleanPath(srcRaw, req.AllowedRoots, true)
			if err != nil {
				return Response{}, err
			}
			dst := filepath.Join(destDir, filepath.Base(src))
			if err := mustNotExist(dst); err != nil {
				return Response{}, err
			}
			afterValidate(src)
			if err := moveChecked(src, dst, req.AllowedRoots); err != nil {
				if errors.Is(err, fs.ErrExist) {
					return Response{}, fmt.Errorf("%s already exists at the destination", filepath.Base(dst))
				}
				return Response{}, fmt.Errorf("move %s failed: %w", filepath.Base(src), err)
			}
		}
		return Response{Op: "move", Path: destDir, Message: fmt.Sprintf("Moved %d item(s)", len(sources))}, nil

	case "delete":
		if !req.ConfirmDestructive {
			return Response{}, errors.New("destructive delete requires explicit confirmation")
		}
		targets := req.Paths
		if len(targets) == 0 && req.Path != "" {
			targets = []string{req.Path}
		}
		if len(targets) == 0 {
			return Response{}, errors.New("at least one path is required to delete")
		}
		for _, raw := range targets {
			clean, err := ValidateAndCleanPath(raw, req.AllowedRoots, true)
			if err != nil {
				return Response{}, err
			}
			afterValidate(clean)
			if err := removeChecked(clean, guard{req.AllowedRoots, true}); err != nil {
				return Response{}, fmt.Errorf("delete %s failed: %w", filepath.Base(clean), err)
			}
		}
		return Response{Op: "delete", Message: fmt.Sprintf("Deleted %d item(s)", len(targets))}, nil

	case "download":
		clean, err := ValidateAndCleanPath(req.Path, req.AllowedRoots, false)
		if err != nil {
			return Response{}, err
		}
		afterValidate(clean)
		return downloadChunk(clean, req.Offset, req.Length, guard{req.AllowedRoots, false})

	case "upload":
		clean, err := ValidateAndCleanPath(req.Path, req.AllowedRoots, true)
		if err != nil {
			return Response{}, err
		}
		afterValidate(clean)
		return uploadChunk(clean, req.Offset, req.DataBase64, req.ExpectedSHA256, req.Overwrite, guard{req.AllowedRoots, true})

	case "hash":
		clean, err := ValidateAndCleanPath(req.Path, req.AllowedRoots, false)
		if err != nil {
			return Response{}, err
		}
		afterValidate(clean)
		return hashFile(clean, guard{req.AllowedRoots, false})

	default:
		return Response{}, fmt.Errorf("unsupported file manager operation: %s", req.Op)
	}
}

// listDir reads the folder through its checked handle (R-7): names and details come from the
// handle, never from a path looked up again after the check.
func listDir(clean string, showHidden bool, roots []string) (Response, error) {
	infos, err := readDirChecked(clean, roots)
	if err != nil {
		return Response{}, fmt.Errorf("read directory failed: %w", err)
	}
	entries := make([]FileEntry, 0, len(infos))
	for _, info := range infos {
		full := filepath.Join(clean, info.Name())
		hidden, sys := isHiddenOrSystem(full, info)
		if !showHidden && (hidden || sys) {
			continue
		}
		entries = append(entries, fileEntry(full, info, hidden, sys))
		if len(entries) >= MaxListEntries {
			break
		}
	}
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].IsDir != entries[j].IsDir {
			return entries[i].IsDir
		}
		return strings.ToLower(entries[i].Name) < strings.ToLower(entries[j].Name)
	})
	parent := filepath.Dir(clean)
	if parent == clean {
		parent = ""
	}
	return Response{
		Op:         "list",
		Path:       clean,
		ParentPath: parent,
		Entries:    entries,
	}, nil
}

func downloadChunk(clean string, offset int64, length int64, g guard) (Response, error) {
	f, err := openChecked(clean, os.O_RDONLY, 0, g)
	if err != nil {
		return Response{}, fmt.Errorf("open failed: %w", err)
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return Response{}, fmt.Errorf("stat failed: %w", err)
	}
	if info.IsDir() {
		return Response{}, errors.New("cannot download a directory directly")
	}
	if offset < 0 {
		offset = 0
	}
	if length <= 0 || length > MaxChunkBytes {
		length = MaxChunkBytes
	}

	if offset > 0 {
		if _, err := f.Seek(offset, io.SeekStart); err != nil {
			return Response{}, fmt.Errorf("seek failed: %w", err)
		}
	}
	buf := make([]byte, length)
	n, err := io.ReadFull(f, buf)
	if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
		return Response{}, fmt.Errorf("read failed: %w", err)
	}
	chunk := buf[:n]
	eof := offset+int64(n) >= info.Size()

	var sumHex string
	if eof && info.Size() <= 32*1024*1024 {
		if _, err := f.Seek(0, io.SeekStart); err == nil {
			h := sha256.New()
			if _, err := io.Copy(h, f); err == nil {
				sumHex = hex.EncodeToString(h.Sum(nil))
			}
		}
	}

	return Response{
		Op:         "download",
		Path:       clean,
		TotalSize:  info.Size(),
		Offset:     offset,
		BytesRead:  int64(n),
		EOF:        eof,
		DataBase64: base64.StdEncoding.EncodeToString(chunk),
		SHA256:     sumHex,
	}, nil
}

// hashFile: the SHA-256 and size of a whole file (the transfer queue checks every finished
// transfer against it, of any size), and whether an interrupted upload of it can be resumed here.
func hashFile(clean string, g guard) (Response, error) {
	f, err := openChecked(clean, os.O_RDONLY, 0, g)
	if err != nil {
		return Response{}, fmt.Errorf("open failed: %w", err)
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return Response{}, fmt.Errorf("stat failed: %w", err)
	}
	if !info.Mode().IsRegular() {
		return Response{}, errors.New("only a regular file can be checked")
	}
	h := sha256.New()
	n, err := io.Copy(h, f)
	if err != nil {
		return Response{}, fmt.Errorf("read failed: %w", err)
	}
	out := Response{Op: "hash", Path: clean, TotalSize: n, SHA256: hex.EncodeToString(h.Sum(nil))}
	if uploads.continues(clean, n) {
		next := n
		out.UploadNext = &next
	}
	return out, nil
}

// uploadTracker remembers the uploads this agent started (created, or overwrote after
// confirmation) and where their next chunk must begin, so a continuation chunk can only extend a
// file its own upload created. An agent restart forgets them: the operator uploads again.
type uploadTracker struct {
	mu sync.Mutex
	m  map[string]trackedUpload
}

type trackedUpload struct {
	next int64
	at   time.Time
}

var uploads = &uploadTracker{m: map[string]trackedUpload{}}

// uploadKey folds case only on Windows, whose paths are case-insensitive; on Linux and macOS
// "Report" and "report" can be different files and must never continue each other's upload.
func uploadKey(p string) string {
	if runtime.GOOS == "windows" {
		return strings.ToLower(filepath.Clean(p))
	}
	return filepath.Clean(p)
}

func (u *uploadTracker) continues(p string, offset int64) bool {
	u.mu.Lock()
	defer u.mu.Unlock()
	t, ok := u.m[uploadKey(p)]
	return ok && t.next == offset && time.Since(t.at) < time.Hour
}

func (u *uploadTracker) advance(p string, next int64) {
	u.mu.Lock()
	defer u.mu.Unlock()
	for k, t := range u.m {
		if time.Since(t.at) > time.Hour {
			delete(u.m, k)
		}
	}
	u.m[uploadKey(p)] = trackedUpload{next: next, at: time.Now()}
}

func (u *uploadTracker) forget(p string) {
	u.mu.Lock()
	defer u.mu.Unlock()
	delete(u.m, uploadKey(p))
}

// ErrUploadTargetExists starts the error an upload gets when its target already exists and the
// request did not carry an operator-confirmed overwrite; the web console looks for this text.
const ErrUploadTargetExists = "upload target already exists"

// uploadChunk writes one chunk. The first chunk (offset 0) creates the file; replacing an existing
// file needs an explicit, operator-confirmed overwrite. A later chunk continues the file this upload
// created: it must start exactly where the file ends, so it can never write into another file.
// (The "append" flag older consoles send is implied by offset > 0 and otherwise ignored.)
func uploadChunk(clean string, offset int64, dataB64 string, expectedSHA256 string, overwrite bool, g guard) (Response, error) {
	raw, err := base64.StdEncoding.DecodeString(dataB64)
	if err != nil {
		return Response{}, errors.New("invalid base64 upload payload")
	}
	if len(raw) > MaxChunkBytes*2 {
		return Response{}, errors.New("upload chunk exceeds maximum permitted chunk size")
	}
	if offset < 0 {
		return Response{}, errors.New("upload offset must not be negative")
	}
	firstChunk := offset == 0
	existing, statErr := os.Lstat(clean)
	exists := statErr == nil
	if statErr != nil && !errors.Is(statErr, fs.ErrNotExist) {
		return Response{}, fmt.Errorf("stat upload target failed: %w", statErr)
	}
	if exists && !existing.Mode().IsRegular() {
		return Response{}, fmt.Errorf("%s is a folder, link or special file and cannot be replaced by an upload", filepath.Base(clean))
	}
	overwritten := false
	// Read-write: the checksum below is read through the same checked handle. Never O_TRUNC: an
	// overwrite truncates only after the handle passed the checks (EXT-8).
	flags := os.O_RDWR
	switch {
	case firstChunk && !exists:
		flags |= os.O_CREATE | os.O_EXCL
	case firstChunk && !overwrite:
		return Response{}, fmt.Errorf("%s: %s (confirm the overwrite to replace it)", ErrUploadTargetExists, filepath.Base(clean))
	case firstChunk:
		overwritten = true
	case !exists:
		return Response{}, errors.New("upload continuation refused: the file this upload started is missing")
	case !uploads.continues(clean, offset):
		return Response{}, fmt.Errorf("upload continuation refused: no upload of %s started here at that offset", filepath.Base(clean))
	case existing.Size() != offset:
		return Response{}, fmt.Errorf("upload continuation refused: the file is %d bytes, the chunk starts at %d", existing.Size(), offset)
	}
	f, err := openChecked(clean, flags, 0o644, g)
	if err != nil {
		if errors.Is(err, fs.ErrExist) {
			return Response{}, fmt.Errorf("%s: %s (confirm the overwrite to replace it)", ErrUploadTargetExists, filepath.Base(clean))
		}
		return Response{}, fmt.Errorf("open for upload failed: %w", err)
	}
	defer f.Close()
	opened, err := f.Stat()
	if err != nil {
		return Response{}, fmt.Errorf("stat upload target failed: %w", err)
	}
	if !opened.Mode().IsRegular() {
		return Response{}, fmt.Errorf("%s is not a regular file and cannot be written by an upload", filepath.Base(clean))
	}
	switch {
	case overwritten:
		if err := f.Truncate(0); err != nil {
			return Response{}, fmt.Errorf("truncate for upload failed: %w", err)
		}
	case !firstChunk && opened.Size() != offset:
		return Response{}, fmt.Errorf("upload continuation refused: the file is %d bytes, the chunk starts at %d", opened.Size(), offset)
	}

	if offset > 0 {
		if _, err := f.Seek(offset, io.SeekStart); err != nil {
			return Response{}, fmt.Errorf("seek for upload failed: %w", err)
		}
	}
	n, err := f.Write(raw)
	if err != nil {
		uploads.forget(clean)
		return Response{}, fmt.Errorf("write failed: %w", err)
	}
	uploads.advance(clean, offset+int64(n))

	info, err := f.Stat()
	if err != nil {
		return Response{}, err
	}

	var sumHex string
	if expectedSHA256 != "" {
		if _, err := f.Seek(0, io.SeekStart); err != nil {
			return Response{}, err
		}
		h := sha256.New()
		if _, err := io.Copy(h, f); err != nil {
			return Response{}, err
		}
		sumHex = hex.EncodeToString(h.Sum(nil))
		if !strings.EqualFold(sumHex, expectedSHA256) {
			return Response{}, fmt.Errorf("upload checksum mismatch: expected %s, got %s", expectedSHA256, sumHex)
		}
	}

	msg := fmt.Sprintf("Uploaded %d bytes to %s", n, filepath.Base(clean))
	if overwritten {
		msg = fmt.Sprintf("Overwrote %s with %d bytes (operator-confirmed)", filepath.Base(clean), n)
	}
	return Response{
		Op:          "upload",
		Path:        clean,
		TotalSize:   info.Size(),
		Offset:      offset,
		BytesRead:   int64(n),
		SHA256:      sumHex,
		Message:     msg,
		Overwritten: overwritten,
	}, nil
}

// copyRecursive copies src to dst; every file is read and written through a checked handle
// (EXT-8) and never replaces anything (the destination tree is new).
func copyRecursive(src, dst string, roots []string) error {
	if isForbiddenCredentialPath(src) || isForbiddenCredentialPath(dst) {
		return errors.New("access to protected credential or security store is forbidden")
	}
	info, err := os.Lstat(src)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return errors.New("refusing to copy symbolic link")
	}
	if info.IsDir() {
		if isSameOrSubpath(dst, src) {
			return errors.New("cannot copy a directory into itself")
		}
		// The folder is listed through its checked handle and the copy is created through checked
		// handles (R-7): a swapped folder can neither show an outside folder's names nor create
		// folders outside the allowed roots.
		sd, _, err := openListedDir(src, roots)
		if err != nil {
			return err
		}
		names, err := sd.names()
		sd.close()
		if err != nil {
			return err
		}
		sort.Strings(names)
		if err := mkdirChecked(dst, guard{roots, true}); err != nil {
			return err
		}
		for _, name := range names {
			if err := copyRecursive(filepath.Join(src, name), filepath.Join(dst, name), roots); err != nil {
				return err
			}
		}
		return nil
	}
	in, err := openChecked(src, os.O_RDONLY, 0, guard{roots, false})
	if err != nil {
		return err
	}
	defer in.Close()
	if st, err := in.Stat(); err != nil || !st.Mode().IsRegular() {
		return errors.New("only regular files are copied")
	}

	out, err := openChecked(dst, os.O_CREATE|os.O_WRONLY|os.O_EXCL, info.Mode().Perm(), guard{roots, true})
	if err != nil {
		return err
	}
	defer out.Close()

	_, err = io.Copy(out, in)
	return err
}
