use std::collections::HashMap;

use uuid::Uuid;

use super::contract::BrowserSurfaceRef;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SurfaceIdentity {
    pub(crate) reference: BrowserSurfaceRef,
    pub(crate) label: String,
}

#[derive(Debug)]
struct SurfaceSlot<T> {
    identity: SurfaceIdentity,
    handle: Option<T>,
}

#[derive(Debug)]
pub(crate) enum BeginCreate<T> {
    Existing(SurfaceIdentity),
    Stale(SurfaceIdentity),
    Reserved {
        identity: SurfaceIdentity,
        replaced: Option<T>,
    },
}

#[derive(Debug)]
pub(crate) enum DestroySurface<T> {
    Destroyed(Option<T>),
    Absent,
    Stale(SurfaceIdentity),
}

#[derive(Debug)]
pub(crate) enum SurfaceHandle<T> {
    Exact(T),
    Absent,
    Stale(SurfaceIdentity),
}

#[derive(Debug)]
pub(crate) struct SurfaceTable<T> {
    slots: HashMap<String, SurfaceSlot<T>>,
}

impl<T> Default for SurfaceTable<T> {
    fn default() -> Self {
        Self {
            slots: HashMap::new(),
        }
    }
}

impl<T> SurfaceTable<T> {
    pub(crate) fn begin_create(&mut self, panel_id: &str, generation: u64) -> BeginCreate<T> {
        if let Some(existing) = self.slots.get(panel_id) {
            if existing.identity.reference.generation == generation {
                return BeginCreate::Existing(existing.identity.clone());
            }
            if existing.identity.reference.generation > generation {
                return BeginCreate::Stale(existing.identity.clone());
            }
        }

        let replaced = self.slots.remove(panel_id).and_then(|slot| slot.handle);
        let token = Uuid::new_v4().simple().to_string();
        let identity = SurfaceIdentity {
            reference: BrowserSurfaceRef {
                panel_id: panel_id.to_string(),
                surface_id: format!("surface-{token}"),
                generation,
            },
            label: format!("browser-{token}"),
        };
        self.slots.insert(
            panel_id.to_string(),
            SurfaceSlot {
                identity: identity.clone(),
                handle: None,
            },
        );
        BeginCreate::Reserved { identity, replaced }
    }

    pub(crate) fn finish_create(&mut self, identity: &SurfaceIdentity, handle: T) -> Option<T> {
        let Some(slot) = self.slots.get_mut(&identity.reference.panel_id) else {
            return Some(handle);
        };
        if slot.identity != *identity {
            return Some(handle);
        }
        slot.handle = Some(handle);
        None
    }

    pub(crate) fn abort_create(&mut self, identity: &SurfaceIdentity) {
        if self
            .slots
            .get(&identity.reference.panel_id)
            .is_some_and(|slot| slot.identity == *identity && slot.handle.is_none())
        {
            self.slots.remove(&identity.reference.panel_id);
        }
    }

    pub(crate) fn handle(&self, reference: &BrowserSurfaceRef) -> Option<T>
    where
        T: Clone,
    {
        self.slots
            .get(&reference.panel_id)
            .filter(|slot| slot.identity.reference == *reference)
            .and_then(|slot| slot.handle.clone())
    }

    pub(crate) fn reference_for_label(&self, label: &str) -> Option<BrowserSurfaceRef> {
        self.slots
            .values()
            .find(|slot| slot.identity.label == label && slot.handle.is_some())
            .map(|slot| slot.identity.reference.clone())
    }

    pub(crate) fn resolve_handle(&self, reference: &BrowserSurfaceRef) -> SurfaceHandle<T>
    where
        T: Clone,
    {
        let Some(slot) = self.slots.get(&reference.panel_id) else {
            return SurfaceHandle::Absent;
        };
        if slot.identity.reference != *reference {
            return SurfaceHandle::Stale(slot.identity.clone());
        }
        match slot.handle.clone() {
            Some(handle) => SurfaceHandle::Exact(handle),
            None => SurfaceHandle::Absent,
        }
    }

    pub(crate) fn destroy(&mut self, reference: &BrowserSurfaceRef) -> Option<T> {
        let matches = self
            .slots
            .get(&reference.panel_id)
            .is_some_and(|slot| slot.identity.reference == *reference);
        if matches {
            self.slots
                .remove(&reference.panel_id)
                .and_then(|slot| slot.handle)
        } else {
            None
        }
    }

    pub(crate) fn destroy_checked(&mut self, reference: &BrowserSurfaceRef) -> DestroySurface<T> {
        let Some(slot) = self.slots.get(&reference.panel_id) else {
            return DestroySurface::Absent;
        };
        if slot.identity.reference != *reference {
            return DestroySurface::Stale(slot.identity.clone());
        }
        DestroySurface::Destroyed(
            self.slots
                .remove(&reference.panel_id)
                .and_then(|slot| slot.handle),
        )
    }

    pub(crate) fn drain(&mut self) -> Vec<(BrowserSurfaceRef, Option<T>)> {
        self.slots
            .drain()
            .map(|(_, slot)| (slot.identity.reference, slot.handle))
            .collect()
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.slots.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reserve(table: &mut SurfaceTable<usize>, panel: &str, generation: u64) -> SurfaceIdentity {
        match table.begin_create(panel, generation) {
            BeginCreate::Reserved { identity, .. } => identity,
            other => panic!("expected reservation, got {other:?}"),
        }
    }

    #[test]
    fn repeated_create_and_destroy_are_idempotent() {
        let mut table = SurfaceTable::default();
        let identity = reserve(&mut table, "panel-1", 1);
        assert!(table.finish_create(&identity, 7).is_none());

        match table.begin_create("panel-1", 1) {
            BeginCreate::Existing(existing) => assert_eq!(existing, identity),
            other => panic!("expected existing identity, got {other:?}"),
        }
        assert_eq!(table.destroy(&identity.reference), Some(7));
        assert_eq!(table.destroy(&identity.reference), None);
        assert_eq!(table.len(), 0);
    }

    #[test]
    fn newer_generation_replaces_old_and_stale_requests_cannot_touch_it() {
        let mut table = SurfaceTable::default();
        let first = reserve(&mut table, "panel-1", 1);
        table.finish_create(&first, 10);

        let second = match table.begin_create("panel-1", 2) {
            BeginCreate::Reserved { identity, replaced } => {
                assert_eq!(replaced, Some(10));
                identity
            }
            other => panic!("expected replacement, got {other:?}"),
        };
        table.finish_create(&second, 20);
        assert!(matches!(
            table.begin_create("panel-1", 1),
            BeginCreate::Stale(_)
        ));
        assert_eq!(table.destroy(&first.reference), None);
        assert_eq!(table.handle(&second.reference), Some(20));
        assert!(matches!(
            table.resolve_handle(&first.reference),
            SurfaceHandle::Stale(_)
        ));
        assert!(matches!(
            table.destroy_checked(&first.reference),
            DestroySurface::Stale(_)
        ));
        assert!(matches!(
            table.destroy_checked(&second.reference),
            DestroySurface::Destroyed(Some(20))
        ));
    }

    #[test]
    fn one_hundred_create_destroy_cycles_leave_no_slots() {
        let mut table = SurfaceTable::default();
        for generation in 1..=100 {
            let identity = reserve(&mut table, "panel-cycle", generation);
            table.finish_create(&identity, generation as usize);
            assert_eq!(
                table.destroy(&identity.reference),
                Some(generation as usize)
            );
        }
        assert_eq!(table.len(), 0);
    }

    #[test]
    fn shutdown_drain_returns_handles_and_clears_reserved_slots() {
        let mut table = SurfaceTable::default();
        let ready = reserve(&mut table, "ready", 1);
        table.finish_create(&ready, 42);
        let _creating = reserve(&mut table, "creating", 1);
        let drained = table.drain();
        assert_eq!(drained.len(), 2);
        assert!(drained
            .iter()
            .any(|(surface, handle)| surface.panel_id == "ready" && *handle == Some(42)));
        assert!(drained
            .iter()
            .any(|(surface, handle)| surface.panel_id == "creating" && handle.is_none()));
        assert_eq!(table.len(), 0);
    }
}
