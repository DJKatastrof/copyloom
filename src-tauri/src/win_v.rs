//! Win+V for the quick panel. Windows keeps Win+V for its own clipboard history; Explorer
//! releases a Win shortcut whose letter is listed in the per-user DisabledHotkeys value, after
//! Explorer restarts. Restoring removes the letter again. Nothing here needs administrator rights.

pub const SHORTCUT: &str = "Super+V";

/// The letters in DisabledHotkeys with V added or removed; other letters stay as they were.
#[cfg(test)]
pub fn edit_letters(current: &str, release: bool) -> String {
    crate::windows_hotkeys::edit_letters(current, 'V', release)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status { pub released: bool, pub registered: bool }

pub fn released() -> Result<bool, String> { crate::windows_hotkeys::released('V') }
pub fn set_released(release: bool) -> Result<(), String> { crate::windows_hotkeys::set_released('V', "ReleasedWinV", release) }
pub use crate::windows_hotkeys::restart_explorer;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_v_is_added_or_removed_and_other_letters_stay() {
        assert_eq!(edit_letters("", true), "V");
        assert_eq!(edit_letters("XE", true), "XEV");
        assert_eq!(edit_letters("XvE", true), "XEV");
        assert_eq!(edit_letters("XVE", false), "XE");
        assert_eq!(edit_letters("V", false), "");
    }
}
