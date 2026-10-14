// Preserve the complete CF_HTML packet, including document styles and fragment offsets.
// HTML is stored as data; it is never rendered inside Copyloom.
pub fn validate_cf_html(bytes: &[u8]) -> Option<String> {
    let end = bytes.iter().position(|byte| *byte == 0).unwrap_or(bytes.len());
    let text = std::str::from_utf8(bytes.get(..end)?).ok()?;
    if !text.starts_with("Version:") { return None; }
    let offset = |name: &str| -> Option<isize> {
        text.lines().take(16).find_map(|line| line.strip_prefix(name))?.trim().parse().ok()
    };
    let start = usize::try_from(offset("StartFragment:")?).ok()?;
    let finish = usize::try_from(offset("EndFragment:")?).ok()?;
    if start > finish || text.get(start..finish)?.is_empty() { return None; }
    let html_start = offset("StartHTML:")?;
    let html_end = offset("EndHTML:")?;
    let packet_end = if html_end >= 0 { usize::try_from(html_end).ok()? } else { text.len() };
    if packet_end < finish || packet_end > text.len() { return None; }
    if html_start >= 0 && usize::try_from(html_start).ok()? > start { return None; }
    Some(text.get(..packet_end)?.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn packet(fragment: &str) -> String {
        let prefix = "<html><head><style>b{color:green}</style></head><body><!--StartFragment-->";
        let suffix = "<!--EndFragment--></body></html>";
        let header = format!("Version:1.0\r\nStartHTML:{:010}\r\nEndHTML:{:010}\r\nStartFragment:{:010}\r\nEndFragment:{:010}\r\n", 0, 0, 0, 0);
        let start = header.len(); let fragment_start = start + prefix.len(); let fragment_end = fragment_start + fragment.len();
        format!("Version:1.0\r\nStartHTML:{start:010}\r\nEndHTML:{:010}\r\nStartFragment:{fragment_start:010}\r\nEndFragment:{fragment_end:010}\r\n{prefix}{fragment}{suffix}", fragment_end + suffix.len())
    }
    #[test]
    fn preserves_unicode_styles_links_and_tables() {
        let html = packet("<b>Åäö</b><a href='https://example.com'>Länk</a><table><tr><td>42</td></tr></table>");
        assert_eq!(validate_cf_html(html.as_bytes()), Some(html.clone()));
        assert_eq!(validate_cf_html(format!("{html}\0padding").as_bytes()), Some(html));
    }
    #[test]
    fn rejects_out_of_bounds_and_non_utf8_boundaries() {
        let html = packet("<b>Åäö</b>");
        assert!(validate_cf_html(html.replace("EndFragment:", "EndFragment:9999999999ignored").as_bytes()).is_none());
        assert!(validate_cf_html(b"Version:1.0\r\nStartHTML:0\r\nEndHTML:99\r\nStartFragment:100\r\nEndFragment:110").is_none());
        assert!(validate_cf_html(b"plain text").is_none());
    }
}
