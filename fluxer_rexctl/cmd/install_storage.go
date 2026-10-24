// SPDX-License-Identifier: AGPL-3.0-or-later

package cmd

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"net/netip"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/spf13/cobra"

	"github.com/fluxerapp/fluxer/fluxer_rexctl/internal/deploy"
	"github.com/fluxerapp/fluxer/fluxer_rexctl/internal/engine"
	"github.com/fluxerapp/fluxer/fluxer_rexctl/internal/instance"
	"github.com/fluxerapp/fluxer/fluxer_rexctl/internal/objectstore"
	"github.com/fluxerapp/fluxer/fluxer_rexctl/internal/settings"
	"github.com/fluxerapp/fluxer/fluxer_rexctl/internal/stack"
	"github.com/fluxerapp/fluxer/fluxer_rexctl/internal/ui"
)

type storageFlags struct {
	Endpoint   string
	Public     string
	Region     string
	PathStyle  bool
	AccessKey  string
	SecretFile string
	Prefix     string
}

type storageChoice struct {
	objectstore.Store
	Public  string
	Prefix  string
	Buckets map[string]string
}

var storageFlagNames = []string{
	"storage-endpoint", "storage-public-endpoint", "storage-region", "storage-path-style", "storage-access-key", "storage-secret-key-file", "storage-bucket-prefix",
}

var storageBucketVars = []string{"FLUXER_S3_BUCKET_CDN", "FLUXER_S3_BUCKET_UPLOADS", "FLUXER_S3_BUCKET_REPORTS", "FLUXER_S3_BUCKET_HARVESTS"}

var storageKeys = append([]string{
	settings.StorageEndpoint, settings.StoragePublic, settings.StorageRegion, settings.StoragePath, settings.StorageAccess, settings.StorageSecret,
}, storageBucketVars...)

var regionSuffixes = []string{".amazonaws.com", ".backblazeb2.com", ".wasabisys.com", ".digitaloceanspaces.com", ".scw.cloud", ".your-objectstorage.com", ".linodeobjects.com"}

var bucketPrefixPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]*$`)

func (f *storageFlags) bind(c *cobra.Command) {
	fl := c.Flags()
	fl.StringVar(&f.Endpoint, "storage-endpoint", "", "your own S3-compatible object store, like https://s3.example.com, instead of the bundled one")
	fl.StringVar(&f.Public, "storage-public-endpoint", "", "the object store address browsers use, when it differs from --storage-endpoint")
	fl.StringVar(&f.Region, "storage-region", "", "the object store region (found from --storage-endpoint when it can be)")
	fl.BoolVar(&f.PathStyle, "storage-path-style", true, "put the bucket in the path of object store addresses instead of the host name")
	fl.StringVar(&f.AccessKey, "storage-access-key", "", "the object store access key")
	fl.StringVar(&f.SecretFile, "storage-secret-key-file", "", "file with the object store secret key, or - for stdin")
	fl.StringVar(&f.Prefix, "storage-bucket-prefix", "", "text to put before each bucket name, like chat- for chat-fluxer")
}

func (f *storageFlags) passed(c *cobra.Command) bool {
	for _, name := range storageFlagNames {
		if fl := c.Flags().Lookup(name); fl != nil && fl.Changed {
			return true
		}
	}
	return false
}

func (f *storageFlags) missing(c *cobra.Command) []string {
	if !f.passed(c) {
		return nil
	}
	var out []string
	for _, r := range []struct{ flag, value string }{
		{"storage-endpoint", f.Endpoint},
		{"storage-access-key", f.AccessKey},
		{"storage-secret-key-file", f.SecretFile},
	} {
		if r.value == "" {
			out = append(out, "--"+r.flag)
		}
	}
	return out
}

func (f *storageFlags) validate(c *cobra.Command) error {
	for _, r := range []struct {
		flag  string
		check func(string) error
	}{
		{"storage-endpoint", validStorageEndpoint},
		{"storage-public-endpoint", storageValidator(settings.StoragePublic)},
		{"storage-region", storageValidator(settings.StorageRegion)},
		{"storage-access-key", storageValidator(settings.StorageAccess)},
		{"storage-bucket-prefix", validBucketPrefix},
	} {
		fl := c.Flags().Lookup(r.flag)
		if fl == nil || !fl.Changed {
			continue
		}
		if err := r.check(strings.TrimSpace(fl.Value.String())); err != nil {
			return ui.Usage(fmt.Sprintf("--%s can't be %q. %s", r.flag, fl.Value.String(), err.Error()))
		}
	}
	return nil
}

func storageValidator(name string) func(string) error {
	k, err := settings.Lookup(stack.Embedded(), nil, name, nil)
	if err != nil || k.Validate == nil {
		return func(string) error { return nil }
	}
	return k.Validate
}

func validStorageEndpoint(v string) error {
	if err := storageValidator(settings.StorageEndpoint)(v); err != nil {
		return err
	}
	u, err := url.Parse(strings.TrimSpace(v))
	if err != nil {
		return err
	}
	host := strings.ToLower(u.Hostname())
	local := host == "localhost" || strings.HasSuffix(host, ".localhost")
	if ip, err := netip.ParseAddr(host); err == nil {
		ip = ip.Unmap()
		local = ip.IsLoopback() || ip.IsLinkLocalUnicast()
	}
	if local {
		return setupInputError(fmt.Sprintf("Fluxer's containers can't reach %s, because it's this machine's own loopback or link-local address. Use the object store's domain name or this machine's network IP address.", host))
	}
	return nil
}

func bucketDefaults() map[string]string {
	out := map[string]string{}
	for _, v := range storageBucketVars {
		if b := instance.ReleaseDefault(stack.Embedded(), v); b != "" {
			out[v] = b
		}
	}
	return out
}

func validBucketPrefix(v string) error {
	if v == "" {
		return nil
	}
	longest := 0
	for _, b := range bucketDefaults() {
		longest = max(longest, len(b))
	}
	most := 63 - longest
	if !bucketPrefixPattern.MatchString(v) || len(v) > most || strings.HasPrefix(v, "xn--") || strings.HasPrefix(v, "sthree-") {
		return setupInputError(fmt.Sprintf("Use up to %d lowercase letters, numbers or hyphens, starting with a letter or number.", most))
	}
	return nil
}

func (s *storageChoice) bucketNames() []string {
	var out []string
	for _, v := range storageBucketVars {
		if b, ok := s.Buckets[v]; ok {
			out = append(out, b)
		}
	}
	return out
}

func guessRegion(endpoint string) string {
	u, err := url.Parse(endpoint)
	if err == nil {
		host := strings.ToLower(u.Hostname())
		if strings.HasSuffix(host, ".r2.cloudflarestorage.com") {
			return "auto"
		}
		for _, suffix := range regionSuffixes {
			rest, ok := strings.CutSuffix(host, suffix)
			if !ok {
				continue
			}
			label := strings.TrimPrefix(rest[strings.LastIndex(rest, ".")+1:], "s3-")
			if label != "" && label != "s3" {
				return label
			}
		}
	}
	return instance.ReleaseDefault(stack.Embedded(), "FLUXER_S3_REGION")
}

func (in *installer) askStorage() error {
	u := in.app.UI
	f := &in.f.Storage
	if !f.passed(in.c) {
		if !u.Interactive() {
			return nil
		}
		choice := "bundled"
		if err := u.Ask(nil, ui.Field{
			Title: "Where do you want to keep uploaded files?",
			Value: &choice,
			Options: []ui.Option{
				{Label: "In Fluxer's bundled object store", Value: "bundled"},
				{Label: "In my own S3-compatible object store", Value: "own"},
			},
		}); err != nil || choice == "bundled" {
			return err
		}
	}
	if err := u.Ask(in.c,
		ui.Field{Flag: "storage-endpoint", Title: "Object store address", Value: &f.Endpoint, Validate: validStorageEndpoint},
		ui.Field{Flag: "storage-access-key", Title: "Access key", Value: &f.AccessKey, Validate: storageValidator(settings.StorageAccess)},
	); err != nil {
		return err
	}
	secret, err := askSecret(in.app, in.c, "storage-secret-key-file", "Secret key", f.SecretFile, storageValidator(settings.StorageSecret))
	if err != nil {
		return err
	}
	pathStyle := strconv.FormatBool(f.PathStyle)
	if err := u.Ask(in.c,
		ui.Field{Flag: "storage-region", Title: "Region", Value: &f.Region, Default: guessRegion(strings.TrimSpace(f.Endpoint)), Validate: storageValidator(settings.StorageRegion)},
		ui.Field{Flag: "storage-bucket-prefix", Title: "Bucket name prefix, if your provider shares bucket names with other accounts", Value: &f.Prefix, Optional: true, Validate: validBucketPrefix},
		ui.Field{
			Flag:     "storage-path-style",
			Title:    "Where does the bucket go in the address?",
			Value:    &pathStyle,
			Validate: storageValidator(settings.StoragePath),
			Options: []ui.Option{
				{Label: "In the path, like s3.example.com/bucket", Value: "true"},
				{Label: "In the host name, like bucket.s3.example.com", Value: "false"},
			},
		},
		ui.Field{Flag: "storage-public-endpoint", Title: "Address browsers use, if it's different", Value: &f.Public, Optional: true, Validate: storageValidator(settings.StoragePublic)},
	); err != nil {
		return err
	}
	prefix := strings.TrimSpace(f.Prefix)
	buckets := bucketDefaults()
	for v, b := range buckets {
		buckets[v] = prefix + b
	}
	in.storage = &storageChoice{
		Store: objectstore.Store{
			Endpoint:  strings.TrimSpace(f.Endpoint),
			Region:    strings.TrimSpace(f.Region),
			AccessKey: strings.TrimSpace(f.AccessKey),
			SecretKey: secret,
			PathStyle: pathStyle == "true",
		},
		Public:  strings.TrimSpace(f.Public),
		Prefix:  prefix,
		Buckets: buckets,
	}
	return nil
}

func (in *installer) checkStorage(ctx context.Context) error {
	s := in.storage
	if s == nil {
		return nil
	}
	if in.f.DryRun {
		in.plan = append(in.plan, fmt.Sprintf("Check that Fluxer can use the buckets %s in your object store.", ui.JoinAnd(buckets)))
		return nil
	}
	err := in.app.UI.Step(ctx, "Checking your object store", func(ctx context.Context, st *ui.Step) error {
		if err := s.Check(ctx, buckets); err != nil {
			return err
		}
	}
}

func (in *installer) storageFailure(err error) error {
	var se *objectstore.Error
	if !errors.As(err, &se) {
		return err
	}
	s := in.storage
	again := "then run rexctl install again."
	switch se.Problem {
	case objectstore.Unreachable:
		return ui.Wrap(err, fmt.Sprintf("Couldn't reach your object store at %s.", s.Endpoint), "Check the address and that this machine can connect to it, "+again)
	case objectstore.Credentials:
		return ui.Wrap(err, "Your object store didn't accept the access key and secret key.", "Check both keys, "+again)
	case objectstore.WrongRegion:
		return ui.Wrap(err, "Your object store expects a different region.", "Check the region your provider shows for the bucket, "+again)
	case objectstore.MissingBuckets:
		if len(se.Buckets) == 1 {
			msg = fmt.Sprintf("Your object store has no bucket called %s.", se.Buckets[0])
		}
	case objectstore.Denied:
		return ui.Wrap(err, fmt.Sprintf("The access key can't read and write files in the bucket %s.", ui.JoinAnd(se.Buckets)),
			fmt.Sprintf("Give the key read, write and delete access to the buckets %s, %s", ui.JoinAnd(s.bucketNames()), again)+in.prefixHint())
	}
	return ui.Wrap(err, fmt.Sprintf("Your object store answered with an error: %s.", strings.TrimSuffix(se.Error(), ".")), "Check your object store settings, "+again)
}

func (in *installer) prefixHint() string {
	if in.storage.Prefix != "" {
		return ""
	}
	how := "pass the prefix with --storage-bucket-prefix"
	if in.app.UI.Interactive() {
		how = "enter the prefix when rexctl asks for a bucket name prefix"
	}
	return fmt.Sprintf(" If another account already has those names on your provider, create the buckets with a prefix, like chat-%s, and %s.", in.storage.bucketNames()[0], how)
}

func (s *storageChoice) values() map[string]string {
	out := map[string]string{
		settings.StorageEndpoint: s.Endpoint,
		settings.StorageRegion:   s.Region,
		settings.StorageAccess:   s.AccessKey,
		settings.StorageSecret:   s.SecretKey,
	}
	if !s.PathStyle {
		out[settings.StoragePath] = "false"
	}
	if s.Public != "" {
		out[settings.StoragePublic] = s.Public
	}
	if s.Prefix != "" {
		maps.Copy(out, s.Buckets)
	}
	return out
}

func (in *installer) resumeStorage(ctx context.Context, inst *instance.Instance) error {
	if !in.f.Storage.passed(in.c) {
		return nil
	}
	if err := in.askStorage(); err != nil {
		return err
	}
	current := map[string]string{}
	for _, k := range storageKeys {
		if v, ok := inst.State.Settings[k]; ok {
			current[k] = v
		}
	}
	if maps.Equal(current, want) {
		return nil
	}
	if endpoint := current[settings.StorageEndpoint]; endpoint != "" {
		return ui.Refused(fmt.Sprintf("This unfinished install already uses different object store settings, with the store at %s.", endpoint),
			"Run rexctl install again without the storage options to keep them, or change them after the install with rexctl config set.")
	}
	if err := in.checkStorage(ctx); err != nil {
		return err
	}
	changes := map[string]*string{}
	for _, k := range slices.Sorted(maps.Keys(want)) {
		v := want[k]
		changes[k] = &v
	}
	return in.app.ChangeSettings(ctx, inst, func(e *engine.Engine) error {
		var logPath string
		change, err := deploy.Set(ctx, inst, e, changes, deploy.ApplyOptions{
			Wait: true,
			Failed: func(p *engine.Project, err error) {
				logPath = writeFailureLog(ctx, inst, p, "start.log", err, nil)
			},
		})
		if err != nil {
			return settingsFailure(change, err, logPath)
		}
		in.app.UI.OK("Saved your object store settings.")
		return nil
	})
}
