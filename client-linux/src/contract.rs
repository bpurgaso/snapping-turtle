//! Cross-language contract check: the constants this crate mirrors from
//! shared/src/constants.ts are read from that file at test time, so a
//! change on the TypeScript side fails `cargo test` here instead of drifting.
//! (`include_str!` resolves relative to this source file — the repo layout
//! puts shared/ two directories up.)

#[cfg(test)]
mod tests {
    const SHARED_CONSTANTS: &str = include_str!("../../shared/src/constants.ts");

    fn number(name: &str) -> u64 {
        let needle = format!("export const {name} = ");
        let line = SHARED_CONSTANTS
            .lines()
            .find(|l| l.starts_with(&needle))
            .unwrap_or_else(|| panic!("{name} not found in shared/src/constants.ts"));
        let value: String = line[needle.len()..]
            .chars()
            .take_while(|c| c.is_ascii_digit() || *c == '_')
            .collect();
        value
            .replace('_', "")
            .parse()
            .unwrap_or_else(|_| panic!("{name}: {line}"))
    }

    fn string_field(object: &str, key: &str) -> String {
        let start = SHARED_CONSTANTS
            .find(&format!("export const {object} = {{"))
            .expect(object);
        let body = &SHARED_CONSTANTS[start..];
        let end = body.find("} as const").expect("object end");
        let body = &body[..end];
        let line = body
            .lines()
            .find(|l| l.trim_start().starts_with(&format!("{key}:")))
            .expect(key);
        line.split('\'').nth(1).expect("quoted value").to_string()
    }

    #[test]
    fn upload_cap_matches_shared() {
        assert_eq!(crate::api::MAX_UPLOAD_MB, number("MAX_UPLOAD_MB"));
    }

    #[test]
    fn multipart_field_names_match_shared() {
        assert_eq!(
            crate::api::FIELD_IMAGE,
            string_field("CAPTURE_UPLOAD_FIELDS", "image")
        );
        assert_eq!(
            crate::api::FIELD_TITLE,
            string_field("CAPTURE_UPLOAD_FIELDS", "title")
        );
    }

    #[test]
    fn secret_prefix_length_matches_shared() {
        assert_eq!(
            crate::redact::SECRET_LOG_PREFIX_CHARS as u64,
            number("SECRET_LOG_PREFIX_CHARS")
        );
    }

    #[test]
    fn image_caps_match_shared() {
        assert_eq!(
            crate::capture::raw_image::MAX_IMAGE_WIDTH_PX,
            number("MAX_IMAGE_WIDTH_PX") as u32
        );
        assert_eq!(
            crate::capture::raw_image::MAX_IMAGE_HEIGHT_PX,
            number("MAX_IMAGE_HEIGHT_PX") as u32
        );
    }
}
