//! Exact Win+Shift+S detection. Only that combination is consumed; Win+S and all other shortcuts pass.
use windows_sys::Win32::UI::Input::KeyboardAndMouse::*;

#[derive(Default)]
pub(crate) struct Modifiers {
    ctrl: [bool; 2],
    alt: [bool; 2],
    shift: [bool; 2],
    win: [bool; 2],
}

impl Modifiers {
    pub(crate) fn event(&mut self, key: u32, down: bool) -> bool {
        let modifier = match key as u16 {
            VK_CONTROL | VK_LCONTROL => Some(&mut self.ctrl[0]),
            VK_RCONTROL => Some(&mut self.ctrl[1]),
            VK_MENU | VK_LMENU => Some(&mut self.alt[0]),
            VK_RMENU => Some(&mut self.alt[1]),
            VK_SHIFT | VK_LSHIFT => Some(&mut self.shift[0]),
            VK_RSHIFT => Some(&mut self.shift[1]),
            VK_LWIN => Some(&mut self.win[0]),
            VK_RWIN => Some(&mut self.win[1]),
            _ => None,
        };
        if let Some(held) = modifier { *held = down; return true; }
        false
    }

    pub(crate) fn ctrl(&self) -> bool { self.ctrl.contains(&true) }
    pub(crate) fn alt(&self) -> bool { self.alt.contains(&true) }
    pub(crate) fn shift(&self) -> bool { self.shift.contains(&true) }
    pub(crate) fn win(&self) -> bool { self.win.contains(&true) }

    pub(crate) unsafe fn snapshot() -> Self {
        let held = |key| GetAsyncKeyState(key as i32) < 0;
        Self {
            ctrl: [held(VK_LCONTROL), held(VK_RCONTROL)],
            alt: [held(VK_LMENU), held(VK_RMENU)],
            shift: [held(VK_LSHIFT), held(VK_RSHIFT)],
            win: [held(VK_LWIN), held(VK_RWIN)],
        }
    }
}

#[derive(Default)]
pub(crate) struct Keys { modifiers: Modifiers, captured_s: bool }

#[derive(Debug, PartialEq)]
pub(crate) enum Action { Pass, Consume, Capture }

impl Keys {
    pub(crate) fn event(&mut self, key: u32, down: bool, recording: bool) -> Action {
        if self.modifiers.event(key, down) { return Action::Pass; }
        if key != u32::from(b'S') { return Action::Pass; }
        if self.captured_s {
            if !down { self.captured_s = false; }
            return Action::Consume;
        }
        if down && !recording && self.modifiers.shift() && self.modifiers.win()
            && !self.modifiers.ctrl() && !self.modifiers.alt() {
            self.captured_s = true;
            Action::Capture
        } else { Action::Pass }
    }

    pub(crate) unsafe fn snapshot() -> Self {
        Self { modifiers: Modifiers::snapshot(), captured_s: false }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn search_and_history_pass_through_and_only_exact_screenshot_combo_is_consumed() {
        for win in [VK_LWIN, VK_RWIN] {
            for shift in [VK_LSHIFT, VK_RSHIFT] {
                let mut keys = Keys::default();
                assert_eq!(keys.event(win as u32, true, false), Action::Pass);
                assert_eq!(keys.event(b'S' as u32, true, false), Action::Pass);
                assert_eq!(keys.event(b'S' as u32, false, false), Action::Pass);
                assert_eq!(keys.event(b'V' as u32, true, false), Action::Pass);
                assert_eq!(keys.event(b'V' as u32, false, false), Action::Pass);
                assert_eq!(keys.event(shift as u32, true, false), Action::Pass);
                assert_eq!(keys.event(b'S' as u32, true, false), Action::Capture);
                for _ in 0..10 { assert_eq!(keys.event(b'S' as u32, true, false), Action::Consume); }
                assert_eq!(keys.event(shift as u32, false, false), Action::Pass);
                assert_eq!(keys.event(win as u32, false, false), Action::Pass);
                assert_eq!(keys.event(b'S' as u32, false, false), Action::Consume);
                assert_eq!(keys.event(b'S' as u32, true, false), Action::Pass);
            }
        }
    }
    #[test]
    fn extra_modifiers_and_recording_are_never_screenshot_actions() {
        for extra in [VK_LCONTROL, VK_RCONTROL, VK_LMENU, VK_RMENU] {
            let mut keys = Keys::default();
            keys.event(VK_LWIN as u32, true, false);
            keys.event(VK_LSHIFT as u32, true, false);
            keys.event(extra as u32, true, false);
            assert_eq!(keys.event(b'S' as u32, true, false), Action::Pass);
            keys.event(extra as u32, false, false);
            assert_eq!(keys.event(b'S' as u32, true, true), Action::Pass);
            assert_eq!(keys.event(b'S' as u32, false, true), Action::Pass);
            assert_eq!(keys.event(b'S' as u32, true, false), Action::Capture);
            assert_eq!(keys.event(b'S' as u32, false, true), Action::Consume);
        }
    }
    #[test]
    fn releasing_one_side_keeps_the_other_modifier_held() {
        let mut keys = Keys::default();
        for key in [VK_LWIN, VK_RWIN, VK_LSHIFT, VK_RSHIFT] { keys.event(key as u32, true, false); }
        keys.event(VK_LWIN as u32, false, false);
        keys.event(VK_LSHIFT as u32, false, false);
        assert_eq!(keys.event(b'S' as u32, true, false), Action::Capture);
        keys.event(b'S' as u32, false, false);
        keys.event(VK_RSHIFT as u32, false, false);
        assert_eq!(keys.event(b'S' as u32, true, false), Action::Pass);
    }
}
