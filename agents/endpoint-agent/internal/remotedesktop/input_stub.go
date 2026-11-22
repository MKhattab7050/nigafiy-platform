//go:build !windows && !linux && !darwin

package remotedesktop

import "image"

func platformInput(InputEvent) (bool, error) { return false, nil }

func platformCapture() (*image.RGBA, string, bool, error) { return nil, "", false, nil }
