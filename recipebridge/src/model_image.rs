//! Bounded private image evidence for the exception-only relevance model.

use std::io::{Cursor, Write};

use image::{
    DynamicImage, ImageDecoder, ImageFormat, Limits,
    codecs::{gif::GifDecoder, jpeg::JpegDecoder, png::PngDecoder},
    metadata::Orientation,
};
#[cfg(feature = "wasm")]
use wasm_bindgen::prelude::*;

const MAX_SOURCE: usize = 3 * 1024 * 1024;
const MAX_PIXELS: u64 = 6_000_000;
const MAX_DECODED: u64 = 24 * 1024 * 1024;
const MAX_OUTPUT: usize = 128 * 1024;
// Decoder output limits are not a working-memory cap. Reserve for progressive
// coefficients, component planes and decoded RGB, independent of file size.
const MAX_CODEC_WORKING: u64 = 48 * 1024 * 1024;
const CODEC_BYTES_PER_PIXEL: u64 = 16;

/// Hard output bound: noisy images cannot allocate an arbitrarily large JPEG.
struct BoundedJpeg(Vec<u8>, usize);
impl Write for BoundedJpeg {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > self.1.saturating_sub(self.0.len()) {
            return Err(std::io::Error::other("JPEG exceeds image byte budget"));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn limits() -> Limits {
    let mut limits = Limits::default();
    limits.max_image_width = Some(8192);
    limits.max_image_height = Some(8192);
    limits.max_alloc = Some(MAX_DECODED);
    limits
}

fn check_pixels(decoder: &impl ImageDecoder) -> Result<(), String> {
    let (width, height) = decoder.dimensions();
    if u64::from(width) * u64::from(height) > MAX_PIXELS || decoder.total_bytes() > MAX_DECODED {
        return Err("Image exceeds decoded pixel budget".into());
    }
    Ok(())
}

fn decode_still(
    mut decoder: impl ImageDecoder,
    check_jpeg_working_memory: bool,
) -> Result<DynamicImage, String> {
    decoder.set_limits(limits()).map_err(|e| e.to_string())?;
    check_pixels(&decoder)?;
    let (width, height) = decoder.dimensions();
    if check_jpeg_working_memory {
        let padded_pixels =
            u64::from(width.div_ceil(32) * 32) * u64::from(height.div_ceil(32) * 32);
        if padded_pixels * CODEC_BYTES_PER_PIXEL > MAX_CODEC_WORKING {
            return Err("Image exceeds JPEG working memory budget".into());
        }
    }
    let orientation = decoder.orientation().map_err(|e| e.to_string())?;
    let decoded = DynamicImage::from_decoder(decoder).map_err(|e| e.to_string())?;
    Ok(finish_image(decoded, orientation))
}

fn decode(bytes: &[u8]) -> Result<DynamicImage, String> {
    let input = Cursor::new(bytes);
    match image::guess_format(bytes).map_err(|e| e.to_string())? {
        ImageFormat::Jpeg => {
            decode_still(JpegDecoder::new(input).map_err(|e| e.to_string())?, true)
        }
        ImageFormat::Png => {
            let decoder = PngDecoder::with_limits(input, limits()).map_err(|e| e.to_string())?;
            if decoder.is_apng().map_err(|e| e.to_string())? {
                return Err("Animated PNG is unsupported purchase evidence".into());
            }
            decode_still(decoder, false)
        }
        ImageFormat::Gif => {
            // Inspect headers without expanding animation frames into pixel buffers.
            let mut options = gif::DecodeOptions::new();
            options.skip_frame_decoding(true);
            let mut metadata = options
                .read_info(Cursor::new(bytes))
                .map_err(|e| e.to_string())?;
            if metadata
                .next_frame_info()
                .map_err(|e| e.to_string())?
                .is_none()
            {
                return Err("GIF has no frames".into());
            }
            if metadata
                .next_frame_info()
                .map_err(|e| e.to_string())?
                .is_some()
            {
                return Err("Animated GIF is unsupported purchase evidence".into());
            }
            decode_still(GifDecoder::new(input).map_err(|e| e.to_string())?, false)
        }
        _ => Err("Unsupported model image format".into()),
    }
}

fn finish_image(decoded: DynamicImage, orientation: Orientation) -> DynamicImage {
    let (width, height) = (decoded.width(), decoded.height());
    // Composite transparent pixels onto white so transparent receipt backgrounds
    // do not become black text on black. RGB inputs transfer their allocation.
    let rgb = if decoded.color().has_alpha() {
        let rgba = decoded.into_rgba8();
        image::RgbImage::from_fn(width, height, |x, y| {
            let p = rgba.get_pixel(x, y);
            let a = u16::from(p[3]);
            image::Rgb(
                [0, 1, 2].map(|i| ((u16::from(p[i]) * a + 255 * (255 - a) + 127) / 255) as u8),
            )
        })
    } else {
        decoded.into_rgb8()
    };
    let mut oriented = DynamicImage::ImageRgb8(rgb);
    oriented.apply_orientation(orientation);
    oriented
}

/// Private byte-in/byte-out Worker export. Refusals are missing evidence, never negatives.
#[cfg_attr(feature = "wasm", wasm_bindgen)]
pub fn prepare_model_image(bytes: &[u8], detail: bool) -> Result<Vec<u8>, String> {
    if bytes.len() > MAX_SOURCE {
        return Err("Image exceeds source byte budget".into());
    }
    let source = decode(bytes)?;
    let profiles: [(u32, u32, &[u8]); 2] = if detail {
        [(2048, 4096, &[85, 45]), (1280, 2560, &[30])]
    } else {
        [(1280, 2048, &[75, 50]), (960, 1536, &[40])]
    };
    for (width, height, qualities) in profiles {
        let resized;
        let pixels = if source.width() <= width && source.height() <= height {
            &source
        } else {
            // thumbnail averages source blocks directly into the output. resize's
            // separable filters allocate a source-width × output-height RGBA32F
            // scratch image, exceeding the Worker heap for near-limit portraits.
            resized = source.thumbnail(width, height);
            &resized
        };
        for &quality in qualities {
            let mut output = BoundedJpeg(Vec::new(), MAX_OUTPUT);
            let mut encoder = jpeg_encoder::Encoder::new(&mut output, quality);
            // Streaming interleaved chroma subsampling preserves spatial text detail
            // within the byte budget without full-frame coefficient storage.
            encoder.set_sampling_factor(jpeg_encoder::SamplingFactor::F_2_2);
            if encoder
                .encode(
                    pixels.as_bytes(),
                    pixels.width() as u16,
                    pixels.height() as u16,
                    jpeg_encoder::ColorType::Rgb,
                )
                .is_ok()
            {
                return Ok(output.0);
            }
        }
    }
    Err("Image exceeds model image byte budget".into())
}

const MAX_ANALYSIS_SOURCE: usize = 16 * 1024 * 1024;
const MAX_ANALYSIS_EDGE: u32 = 16_384;

/// Sums one output row's source pixels; each source row lands in exactly one.
struct AreaReducer {
    source: (u32, u32),
    output: (u32, u32),
    channels: usize,
    row: u32,
    band: u32,
    sums: Vec<u64>,
    counts: Vec<u32>,
    rgb: Vec<u8>,
}

impl AreaReducer {
    fn push(&mut self, data: &[u8]) {
        let band =
            (u64::from(self.row) * u64::from(self.output.1) / u64::from(self.source.1)) as u32;
        if band != self.band {
            self.flush();
            self.band = band;
        }
        for (x, pixel) in data
            .chunks_exact(self.channels)
            .take(self.source.0 as usize)
            .enumerate()
        {
            let column = x * self.output.0 as usize / self.source.0 as usize;
            // Transparent pixels composite onto white, as `finish_image` does.
            let (rgb, alpha) = match *pixel {
                [g] => ([g; 3], 255),
                [g, a] => ([g; 3], a),
                [r, g, b] => ([r, g, b], 255),
                [r, g, b, a] => ([r, g, b], a),
                _ => unreachable!("normalized PNG rows have 1-4 channels"),
            };
            for (channel, value) in rgb.into_iter().enumerate() {
                let a = u64::from(alpha);
                self.sums[column * 3 + channel] += u64::from(value) * a + 255 * (255 - a);
            }
            self.counts[column] += 255;
        }
        self.row += 1;
    }

    fn flush(&mut self) {
        let width = self.output.0 as usize;
        let start = self.band as usize * width * 3;
        for (column, &count) in self.counts.iter().enumerate() {
            for channel in 0..3 {
                let sum = self.sums[column * 3 + channel];
                self.rgb[start + column * 3 + channel] =
                    ((sum + u64::from(count) / 2) / u64::from(count.max(1))) as u8;
            }
        }
        self.sums.fill(0);
        self.counts.fill(0);
    }
}

/// The JPEG analysis rendition for a PNG the image edge refuses to decode
/// (strict decoders reject a damaged ancillary chunk around intact pixels).
/// Rows stream through an area-average reducer, so working memory is the
/// output rather than the decoded source. Bounded by `max_edge` on both axes.
#[cfg_attr(feature = "wasm", wasm_bindgen)]
pub fn prepare_analysis_png(
    bytes: &[u8],
    max_edge: u32,
    max_output: usize,
) -> Result<Vec<u8>, String> {
    if bytes.len() > MAX_ANALYSIS_SOURCE {
        return Err("PNG exceeds analysis source byte budget".into());
    }
    if image::guess_format(bytes).ok() != Some(ImageFormat::Png) {
        return Err("Analysis fallback requires a PNG".into());
    }
    let mut decoder = png::Decoder::new(Cursor::new(bytes));
    decoder.set_transformations(png::Transformations::normalize_to_color8());
    decoder.set_limits(png::Limits {
        bytes: MAX_DECODED as usize,
    });
    let mut reader = decoder.read_info().map_err(|e| e.to_string())?;
    let info = reader.info();
    let source = (info.width, info.height);
    if info.is_animated() {
        return Err("Animated PNG is unsupported analysis input".into());
    }
    if source.0 > MAX_ANALYSIS_EDGE || source.1 > MAX_ANALYSIS_EDGE {
        return Err("PNG exceeds analysis dimension budget".into());
    }
    let interlaced = info.interlaced;
    let scale = (f64::from(max_edge) / f64::from(source.0.max(source.1))).min(1.0);
    let output = (
        ((f64::from(source.0) * scale).round() as u32).max(1),
        ((f64::from(source.1) * scale).round() as u32).max(1),
    );
    let channels = match reader.output_color_type().0 {
        png::ColorType::Grayscale => 1,
        png::ColorType::GrayscaleAlpha => 2,
        png::ColorType::Rgb => 3,
        png::ColorType::Rgba => 4,
        png::ColorType::Indexed => return Err("PNG palette was not expanded".into()),
    };
    let mut reducer = AreaReducer {
        source,
        output,
        channels,
        row: 0,
        band: 0,
        sums: vec![0; output.0 as usize * 3],
        counts: vec![0; output.0 as usize],
        rgb: vec![0; output.0 as usize * output.1 as usize * 3],
    };
    if interlaced {
        // Adam7 passes are not whole rows; deinterlace within the decoded budget.
        let size = reader
            .output_buffer_size()
            .filter(|&size| size as u64 <= MAX_DECODED)
            .ok_or("Interlaced PNG exceeds decoded pixel budget")?;
        let mut frame = vec![0; size];
        let frame_info = reader.next_frame(&mut frame).map_err(|e| e.to_string())?;
        for row in frame.chunks_exact(frame_info.line_size) {
            reducer.push(row);
        }
    } else {
        while let Some(row) = reader.next_row().map_err(|e| e.to_string())? {
            reducer.push(row.data());
        }
    }
    if reducer.row != source.1 {
        return Err("PNG ended before its last row".into());
    }
    // Trailing chunks only add a late eXIf orientation; a damaged tail after
    // complete pixels is the tolerance this fallback exists for.
    let _ = reader.finish();
    reducer.flush();
    let orientation = reader
        .info()
        .exif_metadata
        .as_deref()
        .and_then(Orientation::from_exif_chunk)
        .unwrap_or(Orientation::NoTransforms);
    let mut oriented = DynamicImage::ImageRgb8(
        image::RgbImage::from_raw(output.0, output.1, reducer.rgb)
            .ok_or("Analysis rendition buffer size mismatch")?,
    );
    oriented.apply_orientation(orientation);
    for quality in [85, 70, 50] {
        let mut jpeg = BoundedJpeg(Vec::new(), max_output);
        let mut encoder = jpeg_encoder::Encoder::new(&mut jpeg, quality);
        encoder.set_sampling_factor(jpeg_encoder::SamplingFactor::F_2_2);
        if encoder
            .encode(
                oriented.as_bytes(),
                oriented.width() as u16,
                oriented.height() as u16,
                jpeg_encoder::ColorType::Rgb,
            )
            .is_ok()
        {
            return Ok(jpeg.0);
        }
    }
    Err("Analysis rendition exceeds byte budget".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{GenericImageView, ImageFormat, Rgb, RgbImage};
    use std::io::Cursor;

    fn png(width: u32, height: u32) -> Vec<u8> {
        let mut pixels = RgbImage::from_pixel(width, height, Rgb([255, 255, 255]));
        for x in 0..width {
            pixels.put_pixel(x, height - 1, Rgb([0, 0, 0]));
        }
        let mut bytes = Cursor::new(Vec::new());
        pixels.write_to(&mut bytes, ImageFormat::Png).unwrap();
        bytes.into_inner()
    }

    #[test]
    fn full_frame_is_bounded_without_upscaling() {
        let bytes = png(1400, 3800);
        for (detail, dimensions) in [(false, (755, 2048)), (true, (1400, 3800))] {
            let output = prepare_model_image(&bytes, detail).unwrap();
            assert!(output.len() <= 128 * 1024);
            let decoded = image::load_from_memory(&output).unwrap();
            assert_eq!(decoded.dimensions(), dimensions);
            assert!(
                decoded
                    .to_rgb8()
                    .get_pixel(dimensions.0 / 2, dimensions.1 - 1)[0]
                    < 200
            );
        }
        let output = prepare_model_image(&png(10, 20), false).unwrap();
        assert_eq!(
            image::load_from_memory(&output).unwrap().dimensions(),
            (10, 20)
        );
    }

    #[test]
    fn rejects_invalid_bytes_and_excessive_source_or_pixels() {
        assert!(prepare_model_image(b"not an image", false).is_err());
        assert!(prepare_model_image(&vec![0; 3 * 1024 * 1024 + 1], false).is_err());
        assert!(prepare_model_image(&png(3000, 3000), false).is_err());
    }
    #[test]
    fn transparency_is_white_and_jpeg_orientation_is_preserved() {
        let mut input = Cursor::new(Vec::new());
        image::RgbaImage::from_pixel(10, 20, image::Rgba([0, 0, 0, 0]))
            .write_to(&mut input, ImageFormat::Png)
            .unwrap();
        let output = prepare_model_image(input.get_ref(), false).unwrap();
        assert!(
            image::load_from_memory(&output)
                .unwrap()
                .to_rgb8()
                .pixels()
                .all(|p| p[0] > 250)
        );

        let jpeg = prepare_model_image(&png(10, 20), false).unwrap();
        // Synthetic TIFF orientation 6 (90 degrees clockwise), in JPEG APP1.
        let exif = b"Exif\0\0II\x2a\0\x08\0\0\0\x01\0\x12\x01\x03\0\x01\0\0\0\x06\0\0\0\0\0\0\0";
        let mut rotated = jpeg[..2].to_vec();
        rotated.extend_from_slice(&[0xff, 0xe1]);
        rotated.extend_from_slice(&((exif.len() + 2) as u16).to_be_bytes());
        rotated.extend_from_slice(exif);
        rotated.extend_from_slice(&jpeg[2..]);
        let output = prepare_model_image(&rotated, false).unwrap();
        assert_eq!(
            image::load_from_memory(&output).unwrap().dimensions(),
            (20, 10)
        );
    }

    #[test]
    fn animation_is_missing_evidence_not_a_first_frame() {
        let apng = &[
            137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1,
            8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 8, 97, 99, 84, 76, 0, 0, 0, 1, 0, 0, 0, 0,
            180, 45, 233, 160, 0, 0, 0, 26, 102, 99, 84, 76, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0,
            0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 10, 0, 0, 90, 127, 48, 208, 0, 0, 0, 11, 73, 68, 65, 84,
            120, 156, 99, 248, 15, 4, 0, 9, 251, 3, 253, 251, 94, 107, 43, 0, 0, 0, 0, 73, 69, 78,
            68, 174, 66, 96, 130,
        ];
        assert!(
            prepare_model_image(apng, false)
                .unwrap_err()
                .contains("Animated")
        );
        assert!(prepare_model_image(b"GIF89a", false).is_err());
    }
    #[test]
    fn progressive_jpeg_near_pixel_ceiling_is_refused_before_decoding() {
        let bytes = include_bytes!("../fixtures/progressive-large-synthetic.jpg");
        assert!(
            matches!(prepare_model_image(bytes, true), Err(reason) if reason.contains("JPEG working"))
        );
    }

    #[test]
    fn near_limit_portrait_uses_bounded_resize_storage() {
        let output = prepare_model_image(&png(2049, 2928), true).unwrap();
        assert!(output.len() <= MAX_OUTPUT);
        assert!(image::load_from_memory(&output).unwrap().height() >= 2000);
    }
    #[test]
    fn valid_progressive_and_restart_jpegs_keep_the_complete_frame() {
        let rgb = image::load_from_memory(&png(17, 33)).unwrap().into_rgb8();
        for progressive in [false, true] {
            let mut bytes = Vec::new();
            let mut encoder = jpeg_encoder::Encoder::new(&mut bytes, 75);
            encoder.set_progressive(progressive);
            encoder.set_restart_interval(3);
            encoder
                .encode(rgb.as_raw(), 17, 33, jpeg_encoder::ColorType::Rgb)
                .unwrap();
            let output = prepare_model_image(&bytes, false).unwrap();
            assert_eq!(
                image::load_from_memory(&output).unwrap().dimensions(),
                (17, 33)
            );
        }
    }
    #[test]
    fn common_email_formats_become_bounded_jpegs() {
        for format in [ImageFormat::Png, ImageFormat::Jpeg, ImageFormat::Gif] {
            let mut input = Cursor::new(Vec::new());
            DynamicImage::ImageRgb8(RgbImage::from_pixel(64, 96, Rgb([255, 255, 255])))
                .write_to(&mut input, format)
                .unwrap();
            let output = prepare_model_image(input.get_ref(), false).unwrap();
            assert!(output.len() <= MAX_OUTPUT);
            assert_eq!(
                image::load_from_memory(&output).unwrap().dimensions(),
                (64, 96)
            );
        }
    }

    #[test]
    fn animated_gif_does_not_silently_drop_later_frames() {
        let mut input = Vec::new();
        {
            let mut encoder = image::codecs::gif::GifEncoder::new(&mut input);
            for color in [[255, 255, 255, 255], [0, 0, 0, 255]] {
                encoder
                    .encode_frame(image::Frame::new(image::RgbaImage::from_pixel(
                        16,
                        16,
                        image::Rgba(color),
                    )))
                    .unwrap();
            }
        }
        assert!(prepare_model_image(&input, false).is_err());
    }
    /// A synthetic PNG with intact pixels behind an iTXt chunk whose CRC is wrong.
    fn damaged_metadata_png(width: u32, height: u32) -> Vec<u8> {
        let bytes = png(width, height);
        let mut damaged = bytes[..33].to_vec();
        let text = b"XML:com.adobe.xmp\0\0\0\0\0<synthetic/>";
        damaged.extend_from_slice(&(text.len() as u32).to_be_bytes());
        damaged.extend_from_slice(b"iTXt");
        damaged.extend_from_slice(text);
        damaged.extend_from_slice(&0xdead_beef_u32.to_be_bytes());
        damaged.extend_from_slice(&bytes[33..]);
        damaged
    }

    #[test]
    fn analysis_png_with_damaged_metadata_becomes_a_bounded_jpeg() {
        let output =
            prepare_analysis_png(&damaged_metadata_png(900, 1200), 512, 64 * 1024).unwrap();
        let decoded = image::load_from_memory(&output).unwrap();
        assert_eq!(decoded.dimensions(), (384, 512));
        // The bottom row's black line survives the area average.
        assert!(decoded.to_rgb8().get_pixel(192, 511)[0] < 200);
        assert!(decoded.to_rgb8().get_pixel(192, 256)[0] > 250);
        // Smaller sources keep their size; the byte budget is a hard bound.
        let small = prepare_analysis_png(&damaged_metadata_png(10, 20), 512, 64 * 1024).unwrap();
        assert_eq!(
            image::load_from_memory(&small).unwrap().dimensions(),
            (10, 20)
        );
        assert!(prepare_analysis_png(&damaged_metadata_png(900, 1200), 512, 100).is_err());
    }

    #[test]
    fn analysis_png_composites_alpha_and_refuses_other_input() {
        let mut input = Cursor::new(Vec::new());
        image::RgbaImage::from_pixel(10, 20, image::Rgba([0, 0, 0, 0]))
            .write_to(&mut input, ImageFormat::Png)
            .unwrap();
        let output = prepare_analysis_png(input.get_ref(), 2048, 64 * 1024).unwrap();
        assert!(
            image::load_from_memory(&output)
                .unwrap()
                .to_rgb8()
                .pixels()
                .all(|p| p[0] > 250)
        );
        assert!(prepare_analysis_png(b"not an image", 2048, 64 * 1024).is_err());
        let truncated = png(64, 64);
        assert!(prepare_analysis_png(&truncated[..truncated.len() - 40], 2048, 64 * 1024).is_err());
    }

    #[test]
    fn photographic_receipt_fits_both_detail_levels() {
        let bytes = include_bytes!(
            "../../apps/web/src/server/domains/purchase-import/service/gmail/fixtures/synthetic-photographic-receipt.jpg"
        );
        for detail in [false, true] {
            assert!(
                prepare_model_image(bytes, detail).is_ok(),
                "detail={detail}"
            );
        }
    }
}
