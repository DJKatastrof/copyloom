//! Text in stored images, read by the OCR engine built into Windows: on the device, no network.
use windows::{Graphics::Imaging::{BitmapAlphaMode, BitmapPixelFormat, SoftwareBitmap}, Media::Ocr::OcrEngine, Storage::Streams::DataWriter};

const UNAVAILABLE: &str = "Text recognition is not available for your Windows languages. Add a language under Windows Settings → Time & language → Language & region.";
const FAILED: &str = "The text in the image could not be read.";

/// Lines in reading order, separated by CRLF; empty when the image holds no text.
pub fn recognize(png: &[u8]) -> Result<String, String> {
    let mut image = crate::platform::decode_clip_image(png)?;
    let max = OcrEngine::MaxImageDimension().map_err(|_| FAILED)?.max(1);
    if image.width() > max || image.height() > max {
        let scale = f64::from(max) / f64::from(image.width().max(image.height()));
        let size = |side: u32| ((f64::from(side) * scale) as u32).clamp(1, max);
        image = image::imageops::resize(&image, size(image.width()), size(image.height()), image::imageops::FilterType::Triangle);
    }
    let (width, height) = image.dimensions();
    let mut pixels = image.into_raw();
    // BGRA on white: transparent areas must not turn into black blocks around the text.
    for pixel in pixels.chunks_exact_mut(4) {
        let alpha = u32::from(pixel[3]);
        let over = |channel: u8| ((u32::from(channel) * alpha + 255 * (255 - alpha)) / 255) as u8;
        let (red, green, blue) = (over(pixel[0]), over(pixel[1]), over(pixel[2]));
        pixel.copy_from_slice(&[blue, green, red, 255]);
    }
    let engine = OcrEngine::TryCreateFromUserProfileLanguages().map_err(|_| UNAVAILABLE)?;
    let writer = DataWriter::new().map_err(|_| FAILED)?;
    writer.WriteBytes(&pixels).map_err(|_| FAILED)?;
    let buffer = writer.DetachBuffer().map_err(|_| FAILED)?;
    let bitmap = SoftwareBitmap::CreateCopyWithAlphaFromBuffer(&buffer, BitmapPixelFormat::Bgra8, width as i32, height as i32, BitmapAlphaMode::Ignore).map_err(|_| FAILED)?;
    let result = engine.RecognizeAsync(&bitmap).and_then(|operation| operation.join()).map_err(|_| FAILED)?;
    let lines: Vec<String> = result.Lines().map_err(|_| FAILED)?.into_iter().filter_map(|line| line.Text().ok()).map(|text| text.to_string_lossy()).collect();
    Ok(lines.join("\r\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows_sys::Win32::Graphics::Gdi::*;

    /// Draws text with GDI into an opaque bitmap and returns it as PNG.
    fn render(lines: &[&str], transparent_margin: bool) -> Vec<u8> {
        let (width, height) = (900i32, 80 + 70 * lines.len() as i32);
        let mut rgba = vec![0u8; (width * height * 4) as usize];
        unsafe {
            let dc = CreateCompatibleDC(std::ptr::null_mut());
            let mut info: BITMAPINFO = std::mem::zeroed();
            info.bmiHeader = BITMAPINFOHEADER { biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32, biWidth: width, biHeight: -height, biPlanes: 1, biBitCount: 32, biCompression: BI_RGB, ..std::mem::zeroed() };
            let mut bits = std::ptr::null_mut();
            let bitmap = CreateDIBSection(dc, &info, DIB_RGB_COLORS, &mut bits, std::ptr::null_mut(), 0);
            let old = SelectObject(dc, bitmap);
            PatBlt(dc, 0, 0, width, height, WHITENESS);
            let face: Vec<u16> = "Segoe UI".encode_utf16().chain(Some(0)).collect();
            let font = CreateFontW(44, 0, 0, 0, 400, 0, 0, 0, DEFAULT_CHARSET.into(), OUT_DEFAULT_PRECIS.into(), CLIP_DEFAULT_PRECIS.into(), ANTIALIASED_QUALITY.into(), 0, face.as_ptr());
            let old_font = SelectObject(dc, font);
            SetBkMode(dc, TRANSPARENT as i32); SetTextColor(dc, 0);
            for (index, line) in lines.iter().enumerate() {
                let text: Vec<u16> = line.encode_utf16().collect();
                TextOutW(dc, 40, 40 + 70 * index as i32, text.as_ptr(), text.len() as i32);
            }
            GdiFlush();
            let source = std::slice::from_raw_parts(bits as *const u8, rgba.len());
            for (target, pixel) in rgba.chunks_exact_mut(4).zip(source.chunks_exact(4)) { target.copy_from_slice(&[pixel[2], pixel[1], pixel[0], 255]); }
            SelectObject(dc, old_font); DeleteObject(font); SelectObject(dc, old); DeleteObject(bitmap); DeleteDC(dc);
        }
        if transparent_margin {
            // Black, fully transparent border: must read as white background, not as ink.
            for (index, pixel) in rgba.chunks_exact_mut(4).enumerate() { if (index as i32 % width) < 20 { pixel.copy_from_slice(&[0, 0, 0, 0]); } }
        }
        let mut png = Vec::new();
        image::ImageEncoder::write_image(image::codecs::png::PngEncoder::new(&mut png), &rgba, width as u32, height as u32, image::ExtendedColorType::Rgba8).unwrap();
        png
    }

    #[test]
    fn reads_rendered_lines_in_order_on_device() {
        let text = recognize(&render(&["Copyloom reads text", "Second line 2026"], true)).unwrap();
        let lines: Vec<&str> = text.split("\r\n").collect();
        assert_eq!(lines.len(), 2, "{text:?}");
        assert!(lines[0].contains("Copyloom") && lines[1].contains("2026"), "{text:?}");
    }

    #[test]
    fn blank_image_has_no_text() {
        assert_eq!(recognize(&render(&[], false)).unwrap(), "");
    }
}
