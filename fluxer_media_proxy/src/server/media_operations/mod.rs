// SPDX-License-Identifier: AGPL-3.0-or-later

mod failure;
mod input;
mod strip;

pub(in crate::server) use failure::MediaFailure;
pub(in crate::server) use input::{
    MediaInput, MediaInputLimit, STORED_SNIFF_PREFIX_BYTES, load_media_input, read_sniff_prefix,
    spool_stored_media,
};
pub(in crate::server) use strip::{StrippedMedia, probe_audio_duration, strip_media};

use crate::{
    constants::{self, AssetExtension},
    image_quality::ImageQuality,
    image_transform::AnimationMode,
    media_process, mime,
    nsfw::NSFWPolicy,
    output_format::OutputFormat,
    server::{
        format_policy::image_extension_from_filename,
        state::AppState,
        transform::execution::{deadline_instant, run_transform, transform_error_is_timeout},
    },
};
use bytes::Bytes;
use input::LoadedMediaInput;

pub(in crate::server) struct MetadataOutput {
    pub(in crate::server) metadata: serde_json::Value,
    pub(in crate::server) data: Option<Bytes>,
}

pub(in crate::server) async fn resolve_metadata(
    app: &AppState,
    input: MediaInput,
    scan_nsfw: bool,
    include_data: bool,
) -> Result<MetadataOutput, MediaFailure> {
    let mut input = load_media_input(app, input, MediaInputLimit::INTERNAL_REQUEST).await?;
    if include_data && input.data.len() > constants::MAX_MEDIA_PROXY_BYTES {
        return Err(MediaFailure::MetadataDecodedTooLarge);
    }
    if include_data && metadata_input_is_svg(&input) {
        input = rasterize_metadata_svg(app, input).await?;
    }
    let nsfw = if scan_nsfw {
        app.media.nsfw().policy()
    } else {
        app.media.nsfw().record_declined_scan();
        NSFWPolicy::Disabled
    };
    let runtime = app.media.transforms();
    let options = media_process::MetadataOptions {
        placeholder: true,
        nsfw,
        deadline_ms: runtime.transform_deadline_ms(),
    };
    let deadline = deadline_instant(options.deadline_ms);
    let media_limits = app.media.limits();
    let transform_metrics = app.metrics.transform();
    let data = input.data.clone();
    let cost_data = input.data.clone();
    let extraction_failed = |err: &dyn std::fmt::Debug| MediaFailure::MetadataExtractionFailed {
        detail: format!("filename={} err={err:?}", input.filename),
    };
    let prepared = runtime
        .tasks()
        .run_native(
            deadline,
            move || Ok(media_process::metadata_cost(&cost_data, &media_limits)?),
            move || {
                Ok(media_process::prepare_metadata(
                    &data,
                    &options,
                    &media_limits,
                    &transform_metrics,
                )?)
            },
        )
        .await
        .map_err(|err| extraction_failed(&err))?;
    let json = media_process::finish_metadata(prepared, app.media.nsfw())
        .await
        .map_err(|err| extraction_failed(&err))?;
    Ok(MetadataOutput {
        metadata: serde_json::from_str(&json).unwrap_or_else(|_| serde_json::json!({})),
        data: include_data.then_some(input.data),
    })
}

fn metadata_input_is_svg(input: &LoadedMediaInput) -> bool {
    mime::sniff(&input.data).mime == "image/svg+xml"
        || image_extension_from_filename(&input.filename) == Some(AssetExtension::Svg)
}

async fn rasterize_metadata_svg(
    app: &AppState,
    input: LoadedMediaInput,
) -> Result<LoadedMediaInput, MediaFailure> {
    let options = media_process::ImageOptions {
        width: Some(constants::SVG_RASTER_MAX_DIMENSION),
        height: Some(constants::SVG_RASTER_MAX_DIMENSION),
        format: OutputFormat::WebP,
        quality: ImageQuality::Lossless,
        animation: AnimationMode::Static,
        deadline_ms: app.media.transforms().transform_deadline_ms(),
        ..Default::default()
    };
    let filename = input.filename;
    match run_transform(app.media.transforms(), input.data, options).await {
        Ok(media) => Ok(LoadedMediaInput {
            data: media.bytes.into(),
            filename: replace_image_extension(&filename, AssetExtension::Webp),
        }),
        Err(err) if transform_error_is_timeout(&err) => {
            Err(MediaFailure::MetadataSvgRasterizeTimeout { detail: filename })
        }
        Err(err) => Err(MediaFailure::MetadataSvgRasterizeFailed {
            detail: format!("filename={filename} err={err:?}"),
        }),
    }
}

fn replace_image_extension(filename: &str, ext: AssetExtension) -> String {
    let last_slash = filename.rfind('/').map(|idx| idx + 1).unwrap_or(0);
    let last_dot = filename[last_slash..]
        .rfind('.')
        .map(|idx| last_slash + idx);
    match last_dot {
        Some(idx) => format!("{}.{}", &filename[..idx], ext.name()),
        None => format!("{}.{}", filename, ext.name()),
    }
}
