// SPDX-License-Identifier: AGPL-3.0-or-later

package deploy

import (
	"fmt"
	"maps"
	"slices"
	"strconv"
	"strings"

	"github.com/fluxerapp/fluxer/fluxer_rexctl/internal/host"
	"github.com/fluxerapp/fluxer/fluxer_rexctl/internal/instance"
	"github.com/fluxerapp/fluxer/fluxer_rexctl/internal/ui"
)

type portVar struct {
	name   string
	def    int
	protos []string
}

var portVars = []portVar{
	{"FLUXER_HTTP_PORT", 80, []string{"tcp"}},
	{"FLUXER_HTTPS_PORT", 443, []string{"tcp", "udp"}},
	{"FLUXER_LIVEKIT_TCP_PORT", 7881, []string{"tcp"}},
	{"FLUXER_LIVEKIT_UDP_PORT", 7882, []string{"udp"}},
}

func portOf(env map[string]string, v portVar) int {
	if n, err := strconv.Atoi(strings.TrimSpace(env[v.name])); err == nil && n > 0 && n <= 65535 {
		return n
	}
	return v.def
}

func portDiff(oldEnv, newEnv map[string]string) (added, removed []host.Port) {
	for _, v := range portVars {
		was, will := portOf(oldEnv, v), portOf(newEnv, v)
		if was == will {
			continue
		}
		for _, proto := range v.protos {
			added = append(added, host.Port{Number: will, Proto: proto})
			removed = append(removed, host.Port{Number: was, Proto: proto})
		}
	}
	return added, removed
}

func PortChanges(inst *instance.Instance, changes map[string]*string) (opened, closed []host.Port, err error) {
	rs, err := ReleaseSet(inst)
	if err != nil {
		return nil, nil, err
	}
	next := maps.Clone(inst.State.Settings)
	for name, v := range changes {
		if v == nil {
			delete(next, name)
		} else {
			next[name] = *v
		}
	}
	oldEnv, err := Environment(rs, inst.State, inst.State.Settings)
	if err != nil {
		return nil, nil, err
	}
	newEnv, err := Environment(rs, inst.State, next)
	if err != nil {
		return nil, nil, err
	}
	opened, closed = portDiff(oldEnv, newEnv)
	return opened, closed, nil
}

func checkPortsFree(ports []host.Port) error {
	seen := map[host.Port]bool{}
	for _, p := range ports {
		if seen[p] {
			continue
		}
		seen[p] = true
		busy, owner, err := host.PortInUse(p.Proto, p.Number)
		if err != nil || !busy {
			continue
		}
		msg := fmt.Sprintf("Port %d is already in use on this machine.", p.Number)
		if owner != "" {
			msg = fmt.Sprintf("Port %d is already in use by %s.", p.Number, owner)
		}
		return ui.Refused(msg, "Pick another port, or stop what uses it, then try again.")
	}
	return nil
}

func PortList(ports []host.Port) string {
	var nums []int
	for _, p := range ports {
		if !slices.Contains(nums, p.Number) {
			nums = append(nums, p.Number)
		}
	}
	slices.Sort(nums)
	parts := make([]string, len(nums))
	for i, n := range nums {
		parts[i] = strconv.Itoa(n)
	}
	if len(parts) < 2 {
		return strings.Join(parts, "")
	}
	return strings.Join(parts[:len(parts)-1], ", ") + " and " + parts[len(parts)-1]
}
