// SPDX-License-Identifier: AGPL-3.0-or-later

package cmd

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/fluxerapp/fluxer/fluxer_rexctl/internal/backup"
	"github.com/fluxerapp/fluxer/fluxer_rexctl/internal/engine"
	"github.com/fluxerapp/fluxer/fluxer_rexctl/internal/instance"
	"github.com/fluxerapp/fluxer/fluxer_rexctl/internal/stack"
	"github.com/fluxerapp/fluxer/fluxer_rexctl/internal/ui"
)

func newBackupCmd(app *App) *cobra.Command {
	c := &cobra.Command{
		Use:   "backup",
		Short: "Back up your instance",
		Long:  "Back up your instance. Fluxer pauses while uploads are copied.",
		Args:  noArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			return runBackup(c.Context(), app)
		},
	}
	list := &cobra.Command{
		Use:   "list",
		Short: "List your backups",
		Args:  noArgs,
		RunE: func(c *cobra.Command, _ []string) error {
			return runBackupList(app)
		},
	}
	app.jsonFlag(list)
	verify := &cobra.Command{
		Use:   "verify <file>",
		Short: "Check that a backup is complete and readable",
		Args:  exactArgs("the backup file"),
		RunE: func(c *cobra.Command, args []string) error {
			return runBackupVerify(c.Context(), app, args[0])
		},
	}
	c.AddCommand(list, verify)
	return c
}

func runBackup(ctx context.Context, app *App) error {
	inst, err := app.Instance()
	if err != nil {
		return err
	}
	p, err := app.Named(ctx, inst)
	if err != nil {
		return err
	}
	return app.Locked(ctx, inst, func() error {
		running, down := runningParts(ctx, p)
		if running {
			app.UI.Info("Fluxer stops for about a minute while rexctl copies your uploads.")
		}
		if !running || inst.State.Stopped {
			down = nil
		}
		var info *backup.Info
		paused := false
		err := app.UI.Step(ctx, "Backing up your instance", func(ctx context.Context, s *ui.Step) error {
			var err error
			info, err = backup.Create(ctx, inst, p, backup.CreateOptions{
				Reason:  "manual",
				OnEvent: app.progress(s, "Starting"),
				Progress: func(stage string) {
					if stage == backup.StageStarting {
						paused = true
					}
					if t := backupStageTitle(stage); t != "" {
						s.Title(t)
					}
				},
			})
			if err != nil {
				return err
			}
			s.Done("Backed up your instance (%s).", ui.Bytes(info.SizeBytes))
			return nil
		})
		if err != nil {
			return backupCreateErr(err)
		}
		if paused {
			err := app.UI.Step(ctx, "Waiting for Fluxer to start again", func(ctx context.Context, s *ui.Step) error {
				if err := p.WaitReady(ctx, engine.DefaultReadyTimeout, showReadiness(s, "Starting Fluxer again"), down...); err != nil {
					return err
				}
				s.Done("Fluxer is running again.")
				return nil
			})
			if errors.Is(err, context.Canceled) {
				return err
			}
			if err != nil {
				fix := "Run rexctl doctor to find out why."
				var nr *engine.NotReadyError
				if errors.As(err, &nr) {
					if path := keepStartLog(ctx, inst, p, err, nr); path != "" {
						fix = "Read " + path + " to see why."
					}
				}
				return ui.Wrap(err, fmt.Sprintf("Saved the backup to %s, but Fluxer didn't start again.", info.Path), fix)
			}
		}
		if m, err := backup.ReadManifest(info.Path); err == nil {
			warnBackupSkipped(app, m)
		}
		if len(down) > 0 {
			app.UI.Warn(fmt.Sprintf("These services weren't running before the backup and are still stopped: %s.", strings.Join(down, ", ")), "Run rexctl start to start them.")
		}
		app.UI.Result(info.Path)
		return nil
	})
}

func backupStageTitle(stage string) string {
	switch stage {
	case backup.StageFiles:
		return "Copying your settings"
	case backup.StageDatabase:
		return "Saving the database"
	case backup.StageStopping:
		return "Pausing Fluxer to copy uploads"
	case backup.StageVolumes:
		return "Copying uploads and search data while Fluxer is paused"
	case backup.StageStarting:
		return "Starting Fluxer again"
	}
	return ""
}

func warnBackupSkipped(app *App, m *backup.Manifest) {
	if m.HasSkipped(backup.SkippedDatabase) {
		app.UI.Warn("This backup leaves out your database, which runs outside Fluxer.", "")
	}
	if m.HasSkipped(backup.SkippedUploads) {
		app.UI.Warn("This backup leaves out uploads, which are stored outside Fluxer.", "")
	}
}

func backupCreateErr(err error) error {
	var ee *ui.ExitError
	var disk *backup.DiskError
	var dump *backup.DumpError
	var stopped *backup.InterruptedError
	switch {
	case errors.As(err, &stopped) && stopped.Restarted:
		return &ui.ExitError{Code: ui.ExitInterrupted, Msg: "Cancelled the backup. Fluxer is running again.", Err: err}
	case errors.As(err, &ee), errors.Is(err, context.Canceled):
		return err
	case errors.Is(err, backup.ErrNeverStarted):
		return ui.Refused("Fluxer hasn't started on this machine yet, and there's nothing to back up.", "Run rexctl start, then run rexctl backup.")
	case errors.As(err, &disk):
		return ui.Failed(
			fmt.Sprintf("There isn't enough free space for a backup. It needs about %s and %s is free.", ui.Bytes(int64(disk.Need)), ui.Bytes(int64(disk.Available))),
			"Free up some space, then run rexctl backup again.",
		)
	case errors.As(err, &dump):
		return ui.Wrap(fmt.Errorf("%w %s", err, dump.Output), "Couldn't save the database.", "Run rexctl doctor to find the problem.")
	case engine.ClassOf(err) != engine.ClassOther:
		return engineFailure(err)
	}
	return ui.Wrap(err, "Couldn't back up your instance.", "Run rexctl backup again with --verbose to see why.")
}

func runningParts(ctx context.Context, p *engine.Project) (bool, []string) {
	cs, err := p.PS(ctx)
	if err != nil {
		return true, nil
	}
	running := false
	var stopped []string
	for _, c := range cs {
		switch {
		case c.State == "running":
			running = true
		case !stack.OneShot[c.Service] && !slices.Contains(stopped, c.Service):
			stopped = append(stopped, c.Service)
		}
	}
	return running, stopped
}

func runBackupList(app *App) error {
	inst, err := app.Instance()
	if err != nil {
		return err
	}
	list, err := backup.List(inst.BackupDir())
	if err != nil {
		return ui.Wrap(err, fmt.Sprintf("Couldn't read %s.", inst.BackupDir()), "Check that you can open that folder, then try again.")
	}
	if app.Flags.JSON {
		return app.UI.JSON(list)
	}
	if len(list) == 0 {
		app.UI.Info("You don't have any backups yet. Run rexctl backup to make one.")
		return nil
	}
	rows := make([][]string, 0, len(list))
	for _, b := range list {
		rows = append(rows, []string{b.File, backupTime(b.CreatedAt), b.Release, ui.Bytes(b.SizeBytes)})
	}
	app.UI.Table([]string{"File", "Made", "Version", "Size"}, rows)
	return nil
}

func runBackupVerify(ctx context.Context, app *App, arg string) error {
	path := resolveBackupPath(app, arg)
	return app.UI.Step(ctx, "Checking the backup", func(ctx context.Context, s *ui.Step) error {
		m, err := backup.Verify(path)
		if err != nil {
			return backupFileErr(path, err)
		}
		s.Done("The backup is complete. It has %s on %s, made %s.", m.Domain, fluxerName(m.Release), backupTime(m.CreatedAt))
		return nil
	})
}

func resolveBackupPath(app *App, arg string) string {
	if _, err := os.Stat(arg); err == nil || strings.ContainsAny(arg, `/\`) {
		if abs, err := filepath.Abs(arg); err == nil {
			return abs
		}
		return arg
	}
	if dir, err := app.Dir(); err == nil {
		p := filepath.Join(dir, instance.BackupsDir, arg)
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	if abs, err := filepath.Abs(arg); err == nil {
		return abs
	}
	return arg
}

func backupFileErr(path string, err error) error {
	var ee *ui.ExitError
	switch {
	case errors.As(err, &ee), errors.Is(err, context.Canceled):
		return err
	case errors.Is(err, os.ErrNotExist):
		return ui.Failed(fmt.Sprintf("There's no file at %s.", path), "Run rexctl backup list to see your backups.")
	case errors.Is(err, backup.ErrNewer):
		return ui.Refused("This backup was made by a newer version of rexctl.", "Run rexctl upgrade, then try again.")
	case errors.Is(err, backup.ErrNotBackup):
		return ui.Failed(fmt.Sprintf("%s isn't a Fluxer backup, or it was cut short.", filepath.Base(path)), "Check that you picked the right file and that it copied in full.")
	case errors.Is(err, backup.ErrDamaged):
		return ui.Wrap(err, fmt.Sprintf("%s is damaged.", filepath.Base(path)), "Use another backup, or make a new one with rexctl backup.")
	}
	return ui.Wrap(err, fmt.Sprintf("Couldn't read %s.", path), "Check that you can open the file, then try again.")
}

func backupTime(t time.Time) string {
	return t.UTC().Format("2 January 2006 at 15:04 UTC")
}
