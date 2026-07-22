use serde::Deserialize;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BrowserGeometryInput {
    pub(crate) panel_id: String,
    pub(crate) surface_id: String,
    pub(crate) generation: u64,
    pub(crate) revision: u64,
    pub(crate) rect: BrowserCssRect,
    pub(crate) visible: bool,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum InteractiveResizePlacement {
    Left,
    Right,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BrowserInteractiveResizeInput {
    pub(crate) session_id: u64,
    pub(crate) placement: InteractiveResizePlacement,
    pub(crate) start_screen_x: f64,
    pub(crate) min_delta: f64,
    pub(crate) max_delta: f64,
    pub(crate) surfaces: Vec<BrowserGeometryInput>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BrowserInteractiveResizeEndInput {
    pub(crate) session_id: u64,
    pub(crate) surfaces: Vec<BrowserGeometryInput>,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BrowserCssRect {
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) width: f64,
    pub(crate) height: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct BrowserPhysicalRect {
    pub(crate) left: i32,
    pub(crate) top: i32,
    pub(crate) width: i32,
    pub(crate) height: i32,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct BrowserGeometryFrame {
    pub(crate) surface_id: String,
    pub(crate) generation: u64,
    pub(crate) revision: u64,
    pub(crate) rect: BrowserCssRect,
    pub(crate) device_scale_factor: f64,
    pub(crate) visible: bool,
}

impl BrowserGeometryFrame {
    pub(crate) fn physical_rect(&self) -> BrowserPhysicalRect {
        physical_rect(self.rect, self.device_scale_factor)
    }
}

#[derive(Debug, Clone)]
pub(crate) struct NativeInteractiveResizeSurface {
    pub(crate) surface_id: String,
    pub(crate) generation: u64,
    pub(crate) baseline: BrowserPhysicalRect,
    pub(crate) visible: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct NativeInteractiveResizeRequest {
    pub(crate) session_id: u64,
    pub(crate) placement: InteractiveResizePlacement,
    pub(crate) start_screen_x: i32,
    pub(crate) min_delta: i32,
    pub(crate) max_delta: i32,
    pub(crate) surfaces: Vec<NativeInteractiveResizeSurface>,
}

pub(crate) fn physical_rect(rect: BrowserCssRect, scale: f64) -> BrowserPhysicalRect {
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    let x = if rect.x.is_finite() { rect.x } else { 0.0 };
    let y = if rect.y.is_finite() { rect.y } else { 0.0 };
    let width = if rect.width.is_finite() {
        rect.width.max(0.0)
    } else {
        0.0
    };
    let height = if rect.height.is_finite() {
        rect.height.max(0.0)
    } else {
        0.0
    };

    // Round both edges independently. At fractional DPI this avoids the drift
    // caused by round(origin) + round(size).
    let left = saturating_i32((x * scale).round());
    let top = saturating_i32((y * scale).round());
    let right = saturating_i32(((x + width) * scale).round());
    let bottom = saturating_i32(((y + height) * scale).round());

    BrowserPhysicalRect {
        left,
        top,
        width: right.saturating_sub(left).max(0),
        height: bottom.saturating_sub(top).max(0),
    }
}

pub(crate) fn interactive_resize_rect(
    baseline: BrowserPhysicalRect,
    placement: InteractiveResizePlacement,
    delta: i32,
) -> BrowserPhysicalRect {
    match placement {
        InteractiveResizePlacement::Right => BrowserPhysicalRect {
            left: baseline.left.saturating_add(delta),
            top: baseline.top,
            width: baseline.width.saturating_sub(delta).max(1),
            height: baseline.height,
        },
        InteractiveResizePlacement::Left => BrowserPhysicalRect {
            left: baseline.left,
            top: baseline.top,
            width: baseline.width.saturating_add(delta).max(1),
            height: baseline.height,
        },
    }
}

fn saturating_i32(value: f64) -> i32 {
    value.clamp(i32::MIN as f64, i32::MAX as f64) as i32
}

#[derive(Debug, Default)]
pub(crate) struct GeometryMailbox {
    latest: Mutex<HashMap<String, BrowserGeometryFrame>>,
}

impl GeometryMailbox {
    pub(crate) fn shared() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub(crate) fn publish(&self, frame: BrowserGeometryFrame) -> bool {
        let Ok(mut latest) = self.latest.lock() else {
            return false;
        };
        let replace = latest.get(&frame.surface_id).is_none_or(|current| {
            frame.generation > current.generation
                || (frame.generation == current.generation && frame.revision > current.revision)
        });
        if replace {
            latest.insert(frame.surface_id.clone(), frame);
        }
        replace
    }

    pub(crate) fn drain_latest(&self) -> Vec<BrowserGeometryFrame> {
        let Ok(mut latest) = self.latest.lock() else {
            return Vec::new();
        };
        latest.drain().map(|(_, frame)| frame).collect()
    }

    #[cfg(test)]
    fn pending_len(&self) -> usize {
        self.latest.lock().map_or(0, |latest| latest.len())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(surface: &str, generation: u64, revision: u64) -> BrowserGeometryFrame {
        BrowserGeometryFrame {
            surface_id: surface.to_string(),
            generation,
            revision,
            rect: BrowserCssRect {
                x: 10.2,
                y: 20.4,
                width: 200.4,
                height: 300.8,
            },
            device_scale_factor: 1.25,
            visible: true,
        }
    }

    #[test]
    fn keeps_only_the_latest_revision_per_surface() {
        let mailbox = GeometryMailbox::default();
        assert!(mailbox.publish(frame("a", 1, 1)));
        assert!(mailbox.publish(frame("a", 1, 3)));
        assert!(!mailbox.publish(frame("a", 1, 2)));
        assert_eq!(mailbox.pending_len(), 1);
        let frames = mailbox.drain_latest();
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].revision, 3);
        assert_eq!(mailbox.pending_len(), 0);
    }

    #[test]
    fn a_new_generation_supersedes_every_old_revision() {
        let mailbox = GeometryMailbox::default();
        assert!(mailbox.publish(frame("a", 1, 99)));
        assert!(mailbox.publish(frame("a", 2, 1)));
        assert!(!mailbox.publish(frame("a", 1, 100)));
        let frames = mailbox.drain_latest();
        assert_eq!(frames[0].generation, 2);
        assert_eq!(frames[0].revision, 1);
    }

    #[test]
    fn fractional_dpi_rounds_edges_instead_of_accumulating_size_error() {
        let rect = physical_rect(
            BrowserCssRect {
                x: 10.4,
                y: 5.2,
                width: 20.4,
                height: 10.4,
            },
            1.25,
        );
        assert_eq!(rect.left, 13);
        assert_eq!(rect.top, 7);
        assert_eq!(rect.width, 26);
        assert_eq!(rect.height, 13);
    }

    #[test]
    fn interactive_resize_preserves_the_fixed_sidebar_edge() {
        let baseline = BrowserPhysicalRect {
            left: 600,
            top: 80,
            width: 800,
            height: 900,
        };
        let right = interactive_resize_rect(baseline, InteractiveResizePlacement::Right, -120);
        assert_eq!(right.left, 480);
        assert_eq!(right.width, 920);
        assert_eq!(right.left + right.width, baseline.left + baseline.width);

        let left = interactive_resize_rect(baseline, InteractiveResizePlacement::Left, 120);
        assert_eq!(left.left, baseline.left);
        assert_eq!(left.width, 920);
    }
}
