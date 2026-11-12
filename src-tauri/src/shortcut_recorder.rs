//! Recording state for keys Windows consumes before the WebView sees them (Print Screen, Win+Shift+S).
//! Runs in the keyboard helper process; see key_helper.rs.
use crate::screenshot_shortcut::Modifiers;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::*;

#[derive(Default)]
pub(crate) struct Keys { modifiers: Modifiers, pressed: Option<(u32, String)> }

impl Keys {
    pub(crate) unsafe fn snapshot() -> Self { Self { modifiers: Modifiers::snapshot(), pressed: None } }

    pub(crate) fn event(&mut self, key: u32, down: bool, foreground: bool) -> (bool, Option<String>) {
        if self.modifiers.event(key, down) { return (false, None); }
        if self.pressed.as_ref().is_some_and(|(pressed, _)| *pressed == key) {
            let shortcut = if down { None } else { self.pressed.take().map(|(_, shortcut)| shortcut).filter(|_| foreground) };
            return (true, shortcut);
        }
        if down && foreground {
            if let Some(shortcut) = reserved_shortcut(key, self.modifiers.ctrl(), self.modifiers.alt(), self.modifiers.shift(), self.modifiers.win()) {
                self.pressed = Some((key, shortcut));
                return (true, None);
            }
        }
        (false, None)
    }
}

fn reserved_shortcut(key: u32, ctrl: bool, alt: bool, shift: bool, win: bool) -> Option<String> {
    if key != u32::from(VK_SNAPSHOT) && !(key == u32::from(b'S') && shift && win && !ctrl && !alt) { return None; }
    let mut parts = Vec::new();
    if ctrl { parts.push("Ctrl"); }
    if alt { parts.push("Alt"); }
    if shift { parts.push("Shift"); }
    if win { parts.push("Super"); }
    parts.push(if key == u32::from(VK_SNAPSHOT) { "PrintScreen" } else { "S" });
    Some(parts.join("+"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tracks_both_modifier_sides_and_records_once_on_release_after_repeats() {
        for win in [VK_LWIN, VK_RWIN] {
            for shift in [VK_LSHIFT, VK_RSHIFT] {
                let mut keys = Keys::default();
                for key in [win, shift] { assert_eq!(keys.event(key as u32, true, true), (false, None)); }
                for _ in 0..10 { assert_eq!(keys.event(b'S' as u32, true, true), (true, None)); }
                for key in [win, shift] { assert_eq!(keys.event(key as u32, false, true), (false, None)); }
                assert_eq!(keys.event(b'S' as u32, false, true), (true, Some("Shift+Super+S".into())));
                assert_eq!(keys.event(b'S' as u32, false, true), (false, None));
            }
        }
    }

    #[test]
    fn recording_is_foreground_only_and_focus_loss_discards_the_pending_shortcut() {
        let mut keys = Keys::default();
        keys.event(VK_LWIN as u32, true, false);
        keys.event(VK_LSHIFT as u32, true, false);
        assert_eq!(keys.event(b'S' as u32, true, false), (false, None));
        assert_eq!(keys.event(b'S' as u32, true, true), (true, None));
        assert_eq!(keys.event(b'S' as u32, false, false), (true, None));
        assert_eq!(keys.event(b'S' as u32, false, true), (false, None));
        assert_eq!(keys.event(b'V' as u32, true, true), (false, None));
    }

    #[test]
    fn print_screen_preserves_held_modifiers_and_extra_ctrl_does_not_record_windows_s() {
        let mut keys = Keys::default();
        for key in [VK_LWIN, VK_LSHIFT, VK_RCONTROL] { keys.event(key as u32, true, true); }
        assert_eq!(keys.event(b'S' as u32, true, true), (false, None));
        assert_eq!(keys.event(VK_SNAPSHOT as u32, true, true), (true, None));
        assert_eq!(keys.event(VK_SNAPSHOT as u32, false, true), (true, Some("Ctrl+Shift+Super+PrintScreen".into())));
    }

    #[test]
    fn catches_only_screenshot_keys_not_typing_or_history() {
        assert_eq!(reserved_shortcut(b'S' as u32, false, false, true, true).as_deref(), Some("Shift+Super+S"));
        assert_eq!(reserved_shortcut(VK_SNAPSHOT as u32, false, false, false, false).as_deref(), Some("PrintScreen"));
        assert_eq!(reserved_shortcut(VK_SNAPSHOT as u32, true, false, true, false).as_deref(), Some("Ctrl+Shift+PrintScreen"));
        for key in [b'S', b'V', b'A'] {
            assert_eq!(reserved_shortcut(key as u32, false, false, false, false), None);
            assert_eq!(reserved_shortcut(key as u32, false, false, false, true), None);
        }
        assert_eq!(reserved_shortcut(b'S' as u32, true, false, true, true), None);
        assert_eq!(reserved_shortcut(b'S' as u32, false, true, true, true), None);
    }
}
