use tauri::{LogicalPosition, LogicalSize, Position, Rect, Size};

use super::contract::{BrowserLogicalRect, BrowserResourceState};

const MAX_LOGICAL_COORDINATE: f64 = 100_000.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct SurfaceVisibilityPolicy {
    pub(crate) main_window_visible: bool,
    pub(crate) right_sidebar_visible: bool,
    pub(crate) scope_active: bool,
    pub(crate) panel_active: bool,
    pub(crate) positive_area: bool,
    pub(crate) occlusion_count: usize,
    pub(crate) resource_state: BrowserResourceState,
}

impl SurfaceVisibilityPolicy {
    pub(crate) fn should_show(self) -> bool {
        self.main_window_visible
            && self.right_sidebar_visible
            && self.scope_active
            && self.panel_active
            && self.positive_area
            && self.occlusion_count == 0
            && self.resource_state == BrowserResourceState::Visible
    }
}

pub(crate) fn logical_webview_rect(input: &BrowserLogicalRect) -> Result<Rect, &'static str> {
    for value in [input.x, input.y, input.width, input.height] {
        if !value.is_finite() || value.abs() > MAX_LOGICAL_COORDINATE {
            return Err("browser bounds contain an invalid coordinate");
        }
    }
    if input.width < 0.0 || input.height < 0.0 {
        return Err("browser bounds dimensions cannot be negative");
    }
    Ok(Rect {
        position: Position::Logical(LogicalPosition::new(input.x, input.y)),
        size: Size::Logical(LogicalSize::new(input.width, input.height)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn logical_bounds_are_not_scaled_by_device_pixel_ratio() {
        let input = BrowserLogicalRect {
            x: 101.25,
            y: 48.5,
            width: 420.0,
            height: 712.0,
        };
        for _display_scale in [1.0, 1.25, 1.5] {
            let bounds = logical_webview_rect(&input).unwrap();
            match (bounds.position, bounds.size) {
                (Position::Logical(position), Size::Logical(size)) => {
                    assert_eq!(position.x, input.x);
                    assert_eq!(position.y, input.y);
                    assert_eq!(size.width, input.width);
                    assert_eq!(size.height, input.height);
                }
                _ => panic!("bounds must remain logical"),
            }
        }
    }

    #[test]
    fn invalid_or_negative_bounds_are_rejected_but_zero_area_is_supported() {
        assert!(logical_webview_rect(&BrowserLogicalRect {
            x: 0.0,
            y: 0.0,
            width: 0.0,
            height: 0.0,
        })
        .is_ok());
        for width in [-1.0, f64::NAN, 100_001.0] {
            assert!(logical_webview_rect(&BrowserLogicalRect {
                x: 0.0,
                y: 0.0,
                width,
                height: 10.0,
            })
            .is_err());
        }
    }

    #[test]
    fn every_visibility_guard_is_required_and_nested_occlusion_hides() {
        let visible = SurfaceVisibilityPolicy {
            main_window_visible: true,
            right_sidebar_visible: true,
            scope_active: true,
            panel_active: true,
            positive_area: true,
            occlusion_count: 0,
            resource_state: BrowserResourceState::Visible,
        };
        assert!(visible.should_show());
        assert!(!SurfaceVisibilityPolicy {
            occlusion_count: 2,
            ..visible
        }
        .should_show());
        assert!(!SurfaceVisibilityPolicy {
            panel_active: false,
            ..visible
        }
        .should_show());
        assert!(!SurfaceVisibilityPolicy {
            resource_state: BrowserResourceState::Warm,
            ..visible
        }
        .should_show());
    }
}
