//go:build !windows && !linux && !darwin

package filemgr

// renameNoReplace: Unix systems other than Linux and macOS (not shipped today) use the
// check-then-renameat fallback, still relative to both folder handles.
func renameNoReplace(src *dirHandle, srcName string, dst *dirHandle, dstName string) error {
	if err := validName(srcName); err != nil {
		return err
	}
	if err := validName(dstName); err != nil {
		return err
	}
	return renameNoReplaceFallback(src, srcName, dst, dstName)
}
