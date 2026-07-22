use std::collections::VecDeque;

use base64::{engine::general_purpose::STANDARD, Engine as _};

use super::protocol::{TerminalEvent, TERMINAL_REPLAY_LIMIT_CHUNKS};

#[derive(Debug, Clone)]
struct ReplayChunk {
    seq: u64,
    bytes: Vec<u8>,
}

#[derive(Debug)]
pub struct ReplayRing {
    chunks: VecDeque<ReplayChunk>,
    bytes: usize,
    limit: usize,
    chunk_limit: usize,
    next_seq: u64,
}

impl ReplayRing {
    pub fn new(limit: usize) -> Self {
        Self::with_limits(limit, TERMINAL_REPLAY_LIMIT_CHUNKS)
    }

    fn with_limits(limit: usize, chunk_limit: usize) -> Self {
        Self {
            chunks: VecDeque::new(),
            bytes: 0,
            limit,
            chunk_limit: chunk_limit.max(1),
            next_seq: 1,
        }
    }

    pub fn append(&mut self, bytes: &[u8]) -> u64 {
        let seq = self.next_seq;
        self.next_seq = self.next_seq.saturating_add(1);

        if bytes.len() > self.limit {
            self.chunks.clear();
            self.bytes = 0;
            return seq;
        }

        while self.bytes + bytes.len() > self.limit || self.chunks.len() >= self.chunk_limit {
            if let Some(removed) = self.chunks.pop_front() {
                self.bytes = self.bytes.saturating_sub(removed.bytes.len());
            } else {
                break;
            }
        }
        self.bytes += bytes.len();
        self.chunks.push_back(ReplayChunk {
            seq,
            bytes: bytes.to_vec(),
        });
        seq
    }

    pub fn latest_seq(&self) -> u64 {
        self.next_seq.saturating_sub(1)
    }

    pub fn earliest_seq(&self) -> u64 {
        self.chunks
            .front()
            .map(|chunk| chunk.seq)
            .unwrap_or(self.next_seq)
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn retained_bytes(&self) -> usize {
        self.bytes
    }

    #[cfg(test)]
    pub fn retained_chunks(&self) -> usize {
        self.chunks.len()
    }

    pub fn events_after(&self, terminal_id: &str, after_seq: u64) -> (bool, Vec<TerminalEvent>) {
        let earliest = self.earliest_seq();
        let truncated = after_seq.saturating_add(1) < earliest;
        let events = self
            .chunks
            .iter()
            .filter(|chunk| chunk.seq > after_seq)
            .map(|chunk| TerminalEvent::Output {
                terminal_id: terminal_id.to_string(),
                seq: chunk.seq,
                data_base64: STANDARD.encode(&chunk.bytes),
            })
            .collect();
        (truncated, events)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::terminal::protocol::{TERMINAL_MAX_OUTPUT_CHUNK_BYTES, TERMINAL_REPLAY_LIMIT_BYTES};

    #[test]
    fn ring_replays_strictly_after_cursor_and_reports_stale_cursor() {
        let mut ring = ReplayRing::new(6);
        assert_eq!(ring.append(b"one"), 1);
        assert_eq!(ring.append(b"two"), 2);
        assert_eq!(ring.append(b"333"), 3);
        assert_eq!(ring.earliest_seq(), 2);
        assert_eq!(ring.retained_bytes(), 6);

        let (truncated, events) = ring.events_after("terminal-1", 0);
        assert!(truncated);
        assert_eq!(events.len(), 2);
        let (truncated, events) = ring.events_after("terminal-1", 2);
        assert!(!truncated);
        assert_eq!(events.len(), 1);
    }

    #[test]
    fn ring_remains_bounded_under_large_output_and_oversize_chunk() {
        let mut ring = ReplayRing::new(TERMINAL_REPLAY_LIMIT_BYTES);
        let chunks = (10 * 1024 * 1024) / TERMINAL_MAX_OUTPUT_CHUNK_BYTES;
        for _ in 0..chunks {
            ring.append(&vec![7; TERMINAL_MAX_OUTPUT_CHUNK_BYTES]);
        }
        assert!(ring.retained_bytes() <= TERMINAL_REPLAY_LIMIT_BYTES);
        let seq = ring.append(&vec![8; TERMINAL_REPLAY_LIMIT_BYTES + 1]);
        assert_eq!(ring.retained_bytes(), 0);
        assert_eq!(ring.earliest_seq(), seq + 1);
    }

    #[test]
    fn ring_bounds_tiny_output_by_chunk_count_as_well_as_bytes() {
        let mut ring = ReplayRing::with_limits(1024, 3);
        for byte in 0..5 {
            ring.append(&[byte]);
        }
        assert_eq!(ring.retained_chunks(), 3);
        assert_eq!(ring.retained_bytes(), 3);
        assert_eq!(ring.earliest_seq(), 3);
        assert!(ring.events_after("terminal-1", 0).0);
    }
}
