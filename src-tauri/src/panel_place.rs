//! Where the quick panel opens and how large it is. The geometry is pure so it can be tested;
//! the cursor and caret come from `platform`, and the last size and position from a small file.
use serde::{Deserialize, Serialize};

pub const DEFAULT_SIZE: (f64, f64) = (400.0, 480.0);
pub const MIN_SIZE: (f64, f64) = (300.0, 260.0);
/// Logical pixels between the cursor or caret and the panel, and between the panel and the screen edge.
const GAP: f64 = 8.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Area { pub x: i32, pub y: i32, pub width: i32, pub height: i32 }

/// Physical screen coordinates throughout.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Anchor {
    /// Below and to the right of the mouse pointer; above or to the left where the screen ends.
    Pointer(i32, i32),
    /// Below the text cursor, starting at its left edge; above it near the bottom of the screen.
    Caret { x: i32, y: i32, height: i32 },
    Center,
    /// Top-left corner where the panel was last.
    At(i32, i32),
}

/// The panel's physical size on a monitor: the saved logical size, at least the minimum,
/// and never larger than the work area minus a margin on each side.
pub fn fit_size(logical: (f64, f64), scale: f64, area: Area) -> (i32, i32) {
    let margin = (GAP * scale).round() as i32 * 2;
    let width = ((logical.0.max(MIN_SIZE.0) * scale).round() as i32).min(area.width - margin).max(1);
    let height = ((logical.1.max(MIN_SIZE.1) * scale).round() as i32).min(area.height - margin).max(1);
    (width, height)
}

/// Top-left corner for a panel of `size`, always entirely inside `area`.
pub fn place(anchor: Anchor, size: (i32, i32), area: Area, scale: f64) -> (i32, i32) {
    let gap = (GAP * scale).round() as i32;
    let (width, height) = size;
    let (right, bottom) = (area.x + area.width, area.y + area.height);
    let (x, y) = match anchor {
        Anchor::Pointer(x, y) => (
            if x + gap + width <= right { x + gap } else { x - gap - width },
            if y + gap + height <= bottom { y + gap } else { y - gap - height },
        ),
        Anchor::Caret { x, y, height: line } => {
            let below = y + line + gap;
            (x, if below + height <= bottom { below } else { y - gap - height })
        }
        Anchor::Center => (area.x + (area.width - width) / 2, area.y + (area.height - height) / 2),
        Anchor::At(x, y) => (x, y),
    };
    (x.clamp(area.x, (right - width).max(area.x)), y.clamp(area.y, (bottom - height).max(area.y)))
}

/// What is remembered between openings: the logical size, and where it was last (physical).
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Saved { pub width: f64, pub height: f64, pub x: Option<i32>, pub y: Option<i32> }

impl Default for Saved {
    fn default() -> Self { Self { width: DEFAULT_SIZE.0, height: DEFAULT_SIZE.1, x: None, y: None } }
}

const FILE: &str = "panel-state.json";

pub fn load(app: &tauri::AppHandle) -> Saved {
    crate::startup::config_dir(app).ok()
        .and_then(|dir| std::fs::read(dir.join(FILE)).ok())
        .and_then(|bytes| serde_json::from_slice::<Saved>(&bytes).ok())
        .filter(|saved| saved.width.is_finite() && saved.height.is_finite() && saved.width <= 8192.0 && saved.height <= 8192.0)
        .unwrap_or_default()
}

/// Best effort: a panel that opens at its default size next time is no reason to report an error.
pub fn save(app: &tauri::AppHandle, saved: Saved) {
    let Ok(dir) = crate::startup::config_dir(app) else { return };
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(bytes) = serde_json::to_vec(&saved) { let _ = std::fs::write(dir.join(FILE), bytes); }
}

#[cfg(test)]
mod tests {
    use super::*;
    const SCREEN: Area = Area { x: 0, y: 0, width: 1920, height: 1040 };

    #[test]
    fn opens_beside_the_pointer_and_turns_back_at_the_screen_edges() {
        assert_eq!(place(Anchor::Pointer(500, 300), (400, 480), SCREEN, 1.0), (508, 308));
        // Near the right and bottom edges it opens to the left and above instead of being cut off.
        assert_eq!(place(Anchor::Pointer(1800, 1000), (400, 480), SCREEN, 1.0), (1392, 512));
    }

    #[test]
    fn opens_below_the_caret_or_above_it_near_the_bottom() {
        assert_eq!(place(Anchor::Caret { x: 300, y: 200, height: 20 }, (400, 480), SCREEN, 1.0), (300, 228));
        assert_eq!(place(Anchor::Caret { x: 300, y: 900, height: 20 }, (400, 480), SCREEN, 1.0), (300, 412));
        // A caret at the right edge moves the panel inside the screen.
        assert_eq!(place(Anchor::Caret { x: 1900, y: 200, height: 20 }, (400, 480), SCREEN, 1.0).0, 1520);
    }

    #[test]
    fn stays_inside_a_monitor_left_of_and_above_the_primary_at_high_dpi() {
        let left = Area { x: -2560, y: -200, width: 2560, height: 1400 };
        let size = fit_size((400.0, 480.0), 1.5, left);
        assert_eq!(size, (600, 720));
        assert_eq!(place(Anchor::Center, size, left, 1.5), (-1580, 140));
        let (x, y) = place(Anchor::At(5000, -5000), size, left, 1.5);
        assert_eq!((x, y), (-600, -200));
        let (x, y) = place(Anchor::Pointer(-10, 1190), size, left, 1.5);
        assert!(x >= left.x && x + size.0 <= left.x + left.width && y >= left.y && y + size.1 <= left.y + left.height);
    }

    #[test]
    fn size_respects_the_minimum_and_small_screens() {
        assert_eq!(fit_size((100.0, 100.0), 1.0, SCREEN), (300, 260));
        assert_eq!(fit_size((3000.0, 3000.0), 1.0, Area { x: 0, y: 0, width: 1280, height: 720 }), (1264, 704));
    }
}
