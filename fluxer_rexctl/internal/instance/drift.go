// SPDX-License-Identifier: AGPL-3.0-or-later

package instance

import (
	"bytes"
	"errors"
	"fmt"
	"io/fs"
	"maps"
	"os"
	"path/filepath"
	"slices"

	"github.com/fluxerapp/fluxer/fluxer_rexctl/internal/envfile"
	"github.com/fluxerapp/fluxer/fluxer_rexctl/internal/stack"
	"github.com/fluxerapp/fluxer/fluxer_rexctl/internal/ui"
)

type DriftReport struct {
	Changed []string
	Missing []string
	Env     *EnvDrift
}

type EnvDrift struct {
	Path    string
	Same    bool
	Changes []EnvChange
	Unused  []string
}

type DriftError struct {
	Msg   string
	Fix   string
	Lines []string
}

func (e *DriftError) Error() string { return e.Msg }

func Drift(inst *Instance) (*DriftReport, error) {
	r := &DriftReport{}
	if inst == nil || inst.State == nil || inst.State.Ejected != nil {
		return r, nil
	}
	for _, name := range slices.Sorted(maps.Keys(inst.State.Rendered)) {
		data, err := os.ReadFile(inst.Path(name))
		switch {
		case errors.Is(err, fs.ErrNotExist):
			r.Missing = append(r.Missing, name)
		case err != nil:
			return nil, err
		case stack.Hash(data) != inst.State.Rendered[name]:
			r.Changed = append(r.Changed, name)
		}
	}
	env, err := envDrift(inst)
	if err != nil {
		return nil, err
	}
	r.Env = env
	return r, nil
}

func envDrift(inst *Instance) (*EnvDrift, error) {
	path := inst.Path(EnvFileName)
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	env, _, err := parseEnv(data)
	if err != nil {
		return nil, err
	}
	set, err := inst.Set()
	if err != nil {
		return nil, err
	}
	custom, err := inst.Custom()
	if err != nil {
		return nil, err
	}
	changes, unused, err := compareEnv(set, custom, inst.State, env)
	if err != nil {
		return nil, err
	}
	return &EnvDrift{Path: path, Same: len(changes) == 0 && len(unused) == 0, Changes: changes, Unused: unused}, nil
}

func (r *DriftReport) Err() error {
	if r == nil {
		return nil
	}
	if len(r.Changed) > 0 {
		name := r.Changed[0]
		msg := fmt.Sprintf("%s was changed by hand. rexctl writes this file and would undo your change.", name)
		if len(r.Changed) > 1 {
			msg = fmt.Sprintf("%s were changed by hand. rexctl writes these files and would undo your changes.", ui.JoinAnd(r.Changed))
		}
		return &DriftError{Msg: msg, Fix: "Run rexctl doctor --fix to put rexctl's version back, or rexctl eject to manage the files yourself."}
	}
	if r.Env != nil && !r.Env.Same {
		lines := make([]string, 0, len(r.Env.Changes))
		for _, c := range r.Env.Changes {
			lines = append(lines, c.Command())
		}
		return &DriftError{
			Msg:   "Your instance has a .env file, and rexctl doesn't read it.",
			Fix:   r.Env.Fix(),
			Lines: lines,
		}
	}
	return nil
}

func (r *EnvDrift) Fix() string {
	if len(r.Unused) == 0 {
		return "Run rexctl doctor --fix to keep these values and remove the file, or change them with these commands. rexctl removes the file once you've set each of them:"
	}
	unused := fmt.Sprintf("Fluxer doesn't use %s. Run rexctl config list to find the setting you meant and change it with rexctl config set.", ui.JoinAnd(r.Unused))
	if len(r.Changes) == 0 {
		return unused + " Then delete " + r.Path + "."
	}
	return unused + " Change the others with these commands, then delete " + r.Path + ":"
}

func (r *EnvDrift) Settings() map[string]*string {
	out := map[string]*string{}
	for _, c := range r.Changes {
		if c.Kind == ChangeSetting {
			v := c.Value
			out[c.Key] = &v
		}
	}
	return out
}

func (r *EnvDrift) Values(kind ChangeKind) map[string]string {
	out := map[string]string{}
	for _, c := range r.Changes {
		if c.Kind == kind {
			out[c.Key] = c.Value
		}
	}
	return out
}

func KeepEdited(inst *Instance, name string) (string, error) {
	data, err := os.ReadFile(inst.Path(name))
	if err != nil {
		return "", err
	}
	dst := name + ".mine"
	for n := 2; ; n++ {
		existing, err := os.ReadFile(inst.Path(dst))
		if errors.Is(err, fs.ErrNotExist) || (err == nil && bytes.Equal(existing, data)) {
			break
		}
		if err != nil {
			return "", err
		}
		dst = fmt.Sprintf("%s.mine.%d", name, n)
	}
	if err := envfile.WriteFileAtomic(inst.Path(dst), data, false); err != nil {
		return "", err
	}
	return dst, nil
}

func SettleEnv(inst *Instance, set []string) (string, error) {
	if inst.State == nil || inst.State.Ejected != nil {
		return "", nil
	}
	r, err := envDrift(inst)
	if err != nil || r == nil || len(r.Unused) > 0 {
		return "", err
	}
	for _, c := range r.Changes {
		if !slices.Contains(set, c.Key) {
			return "", nil
		}
	}
	return r.Path, RemoveEnv(inst)
}

func RemoveEnv(inst *Instance) error {
	return removeIfExists(inst.Path(EnvFileName))
}

func copyPrivate(src, dst string) error {
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o700); err != nil {
		return err
	}
	return envfile.WriteFileAtomic(dst, data, true)
}
