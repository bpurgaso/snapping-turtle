//! KWin's ScreenShot2 hands back raw pixels over a pipe with a `format`
//! (a `QImage::Format` enum value), `width`, `height` and `stride`. This
//! converts the formats KWin actually emits to straight-alpha RGBA8 and
//! encodes a PNG. Pure and unit-tested; the DBus plumbing lives in kwin.rs.

/// Mirror shared/src/constants.ts (checked by contract.rs): images past
/// these are refused before upload, matching the server's ingest caps.
pub const MAX_IMAGE_WIDTH_PX: u32 = 10_000;
pub const MAX_IMAGE_HEIGHT_PX: u32 = 32_000;

/// `QImage::Format` values (qimage.h, Qt 6).
pub mod qformat {
    pub const RGB32: u32 = 4; // 0xffRRGGBB as a native u32 → bytes B G R x
    pub const ARGB32: u32 = 5; // 0xAARRGGBB → bytes B G R A
    pub const ARGB32_PREMULTIPLIED: u32 = 6;
    pub const RGBX8888: u32 = 16; // bytes R G B x
    pub const RGBA8888: u32 = 17; // bytes R G B A
    pub const RGBA8888_PREMULTIPLIED: u32 = 18;
    pub const RGBX64: u32 = 25; // 16-bit channels, little-endian, R G B x
    pub const RGBA64: u32 = 26;
    pub const RGBA64_PREMULTIPLIED: u32 = 27;
}

pub struct RawImage {
    pub width: u32,
    pub height: u32,
    pub stride: u32,
    pub format: u32,
    pub data: Vec<u8>,
}

fn unpremultiply(c: u32, a: u32) -> u8 {
    // `checked_div` is None exactly when a == 0: a fully transparent pixel
    // has no colour to recover, so it stays 0.
    (c * 255 + a / 2)
        .checked_div(a)
        .map_or(0, |v| v.min(255) as u8)
}

impl RawImage {
    pub fn bytes_per_pixel(format: u32) -> Option<usize> {
        use qformat::*;
        match format {
            RGB32
            | ARGB32
            | ARGB32_PREMULTIPLIED
            | RGBX8888
            | RGBA8888
            | RGBA8888_PREMULTIPLIED => Some(4),
            RGBX64 | RGBA64 | RGBA64_PREMULTIPLIED => Some(8),
            _ => None,
        }
    }

    /// Straight-alpha RGBA8, `width * height * 4` bytes.
    pub fn to_rgba8(&self) -> Result<Vec<u8>, String> {
        use qformat::*;
        let bpp = Self::bytes_per_pixel(self.format).ok_or_else(|| {
            format!(
                "unsupported KWin image format {} (QImage::Format)",
                self.format
            )
        })?;
        let w = self.width as usize;
        let h = self.height as usize;
        let stride = self.stride as usize;
        if w == 0 || h == 0 {
            return Err("empty image".into());
        }
        if stride < w * bpp || self.data.len() < stride * (h - 1) + w * bpp {
            return Err(format!(
                "short pixel buffer: {} bytes for {}x{} stride {} format {}",
                self.data.len(),
                w,
                h,
                stride,
                self.format
            ));
        }
        let mut out = Vec::with_capacity(w * h * 4);
        for y in 0..h {
            let row = &self.data[y * stride..y * stride + w * bpp];
            for px in row.chunks_exact(bpp) {
                let (r, g, b, a) = match self.format {
                    RGB32 => (px[2], px[1], px[0], 255),
                    ARGB32 => (px[2], px[1], px[0], px[3]),
                    ARGB32_PREMULTIPLIED => {
                        let a = px[3] as u32;
                        (
                            unpremultiply(px[2] as u32, a),
                            unpremultiply(px[1] as u32, a),
                            unpremultiply(px[0] as u32, a),
                            px[3],
                        )
                    }
                    RGBX8888 => (px[0], px[1], px[2], 255),
                    RGBA8888 => (px[0], px[1], px[2], px[3]),
                    RGBA8888_PREMULTIPLIED => {
                        let a = px[3] as u32;
                        (
                            unpremultiply(px[0] as u32, a),
                            unpremultiply(px[1] as u32, a),
                            unpremultiply(px[2] as u32, a),
                            px[3],
                        )
                    }
                    RGBX64 | RGBA64 | RGBA64_PREMULTIPLIED => {
                        // Little-endian u16 channels; keep the high byte.
                        let ch = |i: usize| u16::from_le_bytes([px[2 * i], px[2 * i + 1]]) as u32;
                        let (r, g, b) = (ch(0), ch(1), ch(2));
                        let a = if self.format == RGBX64 { 65535 } else { ch(3) };
                        if self.format == RGBA64_PREMULTIPLIED {
                            let un = |c: u32| {
                                (c * 65535 + a / 2)
                                    .checked_div(a)
                                    .map_or(0, |v| (v >> 8).min(255) as u8)
                            };
                            (un(r), un(g), un(b), (a >> 8) as u8)
                        } else {
                            (
                                (r >> 8) as u8,
                                (g >> 8) as u8,
                                (b >> 8) as u8,
                                (a >> 8) as u8,
                            )
                        }
                    }
                    _ => unreachable!("filtered by bytes_per_pixel"),
                };
                out.extend_from_slice(&[r, g, b, a]);
            }
        }
        Ok(out)
    }
}

/// PNG-encode straight RGBA8 pixels.
pub fn encode_png(width: u32, height: u32, rgba: &[u8]) -> Result<Vec<u8>, String> {
    if rgba.len() != (width as usize) * (height as usize) * 4 {
        return Err("pixel buffer does not match the dimensions".into());
    }
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, width, height);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        enc.set_compression(png::Compression::Fast);
        let mut writer = enc.write_header().map_err(|e| e.to_string())?;
        writer.write_image_data(rgba).map_err(|e| e.to_string())?;
    }
    Ok(out)
}

/// Decode a PNG to straight RGBA8 (the embedded tray icon; also used to
/// size-check portal files before upload).
pub fn decode_png(bytes: &[u8]) -> Result<(u32, u32, Vec<u8>), String> {
    let mut decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    decoder.set_transformations(
        png::Transformations::normalize_to_color8() | png::Transformations::ALPHA,
    );
    let mut reader = decoder.read_info().map_err(|e| e.to_string())?;
    let mut buf = vec![0; reader.output_buffer_size().ok_or("png too large")?];
    let info = reader.next_frame(&mut buf).map_err(|e| e.to_string())?;
    let (w, h) = (info.width, info.height);
    let bytes = &buf[..info.buffer_size()];
    let rgba = match info.color_type {
        png::ColorType::Rgba => bytes.to_vec(),
        png::ColorType::GrayscaleAlpha => bytes
            .as_chunks::<2>()
            .0
            .iter()
            .flat_map(|p| [p[0], p[0], p[0], p[1]])
            .collect(),
        other => return Err(format!("unexpected decoded color type {other:?}")),
    };
    Ok((w, h, rgba))
}

/// Just the header: dimensions of a PNG without decoding the pixels.
pub fn png_dimensions(bytes: &[u8]) -> Result<(u32, u32), String> {
    let decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    let reader = decoder.read_info().map_err(|e| e.to_string())?;
    let info = reader.info();
    Ok((info.width, info.height))
}

/// Refuse what the server would refuse (§12), before spending the upload.
pub fn check_dimensions(width: u32, height: u32) -> Result<(), String> {
    if width > MAX_IMAGE_WIDTH_PX || height > MAX_IMAGE_HEIGHT_PX {
        return Err(format!(
            "The capture is {width}×{height} px; the server accepts at most {MAX_IMAGE_WIDTH_PX}×{MAX_IMAGE_HEIGHT_PX}."
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn img(format: u32, w: u32, h: u32, stride: u32, data: Vec<u8>) -> RawImage {
        RawImage {
            width: w,
            height: h,
            stride,
            format,
            data,
        }
    }

    #[test]
    fn converts_every_supported_8bit_format() {
        // One red pixel at alpha 255 in each layout.
        assert_eq!(
            img(qformat::RGB32, 1, 1, 4, vec![0, 0, 255, 0])
                .to_rgba8()
                .unwrap(),
            [255, 0, 0, 255]
        );
        assert_eq!(
            img(qformat::ARGB32, 1, 1, 4, vec![0, 0, 255, 128])
                .to_rgba8()
                .unwrap(),
            [255, 0, 0, 128]
        );
        // Premultiplied half-alpha red: stored 128,0,0,128 → straight 255,0,0,128.
        assert_eq!(
            img(qformat::ARGB32_PREMULTIPLIED, 1, 1, 4, vec![0, 0, 128, 128])
                .to_rgba8()
                .unwrap(),
            [255, 0, 0, 128]
        );
        assert_eq!(
            img(qformat::RGBX8888, 1, 1, 4, vec![255, 0, 0, 7])
                .to_rgba8()
                .unwrap(),
            [255, 0, 0, 255]
        );
        assert_eq!(
            img(qformat::RGBA8888, 1, 1, 4, vec![255, 0, 0, 9])
                .to_rgba8()
                .unwrap(),
            [255, 0, 0, 9]
        );
        assert_eq!(
            img(
                qformat::RGBA8888_PREMULTIPLIED,
                1,
                1,
                4,
                vec![128, 0, 0, 128]
            )
            .to_rgba8()
            .unwrap(),
            [255, 0, 0, 128]
        );
        assert_eq!(
            img(qformat::RGBA8888_PREMULTIPLIED, 1, 1, 4, vec![0, 0, 0, 0])
                .to_rgba8()
                .unwrap(),
            [0, 0, 0, 0]
        );
    }

    #[test]
    fn converts_16bit_formats_by_high_byte() {
        let px = |r: u16, g: u16, b: u16, a: u16| {
            [r, g, b, a]
                .iter()
                .flat_map(|v| v.to_le_bytes())
                .collect::<Vec<u8>>()
        };
        assert_eq!(
            img(qformat::RGBA64, 1, 1, 8, px(65535, 0, 0x8000, 65535))
                .to_rgba8()
                .unwrap(),
            [255, 0, 128, 255]
        );
        assert_eq!(
            img(qformat::RGBX64, 1, 1, 8, px(0, 65535, 0, 3))
                .to_rgba8()
                .unwrap(),
            [0, 255, 0, 255]
        );
        assert_eq!(
            img(
                qformat::RGBA64_PREMULTIPLIED,
                1,
                1,
                8,
                px(0x8000, 0, 0, 0x8000)
            )
            .to_rgba8()
            .unwrap(),
            [255, 0, 0, 128]
        );
    }

    #[test]
    fn honours_stride_and_rejects_short_buffers() {
        // 2x2 RGBA8888 with an 12-byte stride (4 bytes of padding per row).
        let mut data = vec![];
        for row in 0..2u8 {
            for col in 0..2u8 {
                data.extend_from_slice(&[row * 100, col * 100, 7, 255]);
            }
            data.extend_from_slice(&[9, 9, 9, 9]);
        }
        let out = img(qformat::RGBA8888, 2, 2, 12, data.clone())
            .to_rgba8()
            .unwrap();
        assert_eq!(
            out,
            [0, 0, 7, 255, 0, 100, 7, 255, 100, 0, 7, 255, 100, 100, 7, 255]
        );
        assert!(img(qformat::RGBA8888, 2, 2, 12, data[..19].to_vec())
            .to_rgba8()
            .is_err());
        assert!(img(99, 1, 1, 4, vec![0; 4]).to_rgba8().is_err());
        assert!(img(qformat::RGBA8888, 0, 1, 4, vec![]).to_rgba8().is_err());
    }

    #[test]
    fn png_round_trip_and_header_read() {
        let rgba = vec![
            10, 20, 30, 255, 40, 50, 60, 128, 70, 80, 90, 0, 1, 2, 3, 255,
        ];
        let png = encode_png(2, 2, &rgba).unwrap();
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        assert_eq!(png_dimensions(&png).unwrap(), (2, 2));
        let (w, h, back) = decode_png(&png).unwrap();
        assert_eq!((w, h), (2, 2));
        assert_eq!(back, rgba);
        assert!(encode_png(2, 2, &rgba[..8]).is_err());
        assert!(png_dimensions(b"not a png").is_err());
    }

    #[test]
    fn dimension_caps_match_server_ingest() {
        assert!(check_dimensions(10_000, 32_000).is_ok());
        assert!(check_dimensions(10_001, 100).is_err());
        assert!(check_dimensions(100, 32_001).is_err());
    }
}
