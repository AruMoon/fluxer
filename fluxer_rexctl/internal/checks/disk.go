// SPDX-License-Identifier: AGPL-3.0-or-later

package checks

import (
	"context"
	"fmt"
	"os"
	"runtime"

	"github.com/fluxerapp/fluxer/fluxer_rexctl/internal/engine"
	"github.com/fluxerapp/fluxer/fluxer_rexctl/internal/host"
)

const (
	diskNeededInstall = 20 << 30
	diskLow           = 10 << 30
	diskCritical      = 5 << 30
)

func init() {
	Register(Check{ID: "disk", Phases: Preinstall | Installed, Run: runDisk})
}

func runDisk(ctx context.Context, e *Env) Result {
	free, ok := e.freeDisk()
	if !ok {
		return skip("Couldn't read how much free disk space this machine has.")
	}
	if !e.installed() {
		if free < diskNeededInstall {
			return fail(fmt.Sprintf("This machine has %s of free disk space and Fluxer needs at least 20 GB.", freeGB(free)),
				"Free up space on this machine, then run rexctl doctor.")
		}
		return pass(fmt.Sprintf("This machine has %s of free disk space.", freeGB(free)))
	}
	switch {
	case free < diskCritical:
		return fail(fmt.Sprintf("This machine has only %s of free disk space left.", freeGB(free)),
			"Free up space on this machine, then run rexctl doctor.")
	case free < diskLow:
		return warn(fmt.Sprintf("This machine has %s of free disk space left and an upgrade needs about 10 GB.", freeGB(free)),
			"Free up space on this machine before you upgrade.")
	}
	return pass(fmt.Sprintf("This machine has %s of free disk space.", freeGB(free)))
}

func (e *Env) freeDisk() (uint64, bool) {
	paths := []string{e.Dir}
	if runtime.GOOS == "linux" {
		root := "/var/lib/docker"
		if e.Engine != nil && e.Engine.Kind == engine.Podman {
			root = "/var/lib/containers"
		}
		if e.Engine == nil || !e.Engine.Rootless {
			if _, err := os.Stat(root); err == nil {
				paths = append(paths, root)
			}
		}
	}
	var lowest uint64
	found := false
	for _, p := range paths {
		free, err := host.FreeDisk(p)
		if err != nil {
			continue
		}
		if !found || free < lowest {
			lowest, found = free, true
		}
	}
	return lowest, found
}

func freeGB(bytes uint64) string {
	return fmt.Sprintf("%d GB", bytes>>30)
}
