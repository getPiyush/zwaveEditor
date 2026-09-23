//! Peak extraction for waveform drawing.
//!
//! The UI never receives raw samples: it asks for exactly as many buckets as it
//! has pixels for the visible range, so the cost of drawing is independent of
//! how long the file is.

/// Values packed per bucket: min, max, rms.
pub const VALUES_PER_BUCKET: usize = 3;

/// Reduce `samples[start..end]` to `width` buckets of (min, max, rms).
///
/// When the window is zoomed in past one sample per bucket, each bucket reports
/// the nearest single sample, which lets the UI draw the true sample envelope.
pub fn compute(samples: &[f32], start: usize, end: usize, width: usize) -> Vec<f32> {
    let mut out = vec![0.0f32; width * VALUES_PER_BUCKET];
    if width == 0 || samples.is_empty() {
        return out;
    }

    let start = start.min(samples.len());
    let end = end.clamp(start, samples.len());
    let span = end - start;
    if span == 0 {
        return out;
    }

    let step = span as f64 / width as f64;

    for bucket in 0..width {
        let from = start + (bucket as f64 * step) as usize;
        let to = (start + ((bucket + 1) as f64 * step).ceil() as usize)
            .min(end)
            .max(from + 1)
            .min(samples.len());

        let slice = &samples[from..to];
        let mut min = f32::MAX;
        let mut max = f32::MIN;
        let mut sum_sq = 0.0f64;

        for &s in slice {
            if s < min {
                min = s;
            }
            if s > max {
                max = s;
            }
            sum_sq += (s as f64) * (s as f64);
        }

        let rms = (sum_sq / slice.len() as f64).sqrt() as f32;
        let base = bucket * VALUES_PER_BUCKET;
        out[base] = min;
        out[base + 1] = max;
        out[base + 2] = rms;
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_input_yields_zeroed_buckets() {
        assert_eq!(compute(&[], 0, 0, 4), vec![0.0; 12]);
    }

    #[test]
    fn captures_extremes_of_each_bucket() {
        let samples = [0.0, 1.0, -1.0, 0.5];
        let peaks = compute(&samples, 0, 4, 2);
        assert_eq!(peaks[0], 0.0); // bucket 0 min
        assert_eq!(peaks[1], 1.0); // bucket 0 max
        assert_eq!(peaks[3], -1.0); // bucket 1 min
        assert_eq!(peaks[4], 0.5); // bucket 1 max
    }

    #[test]
    fn zoomed_past_one_sample_per_bucket_still_fills_every_bucket() {
        let samples = [0.25, 0.75];
        let peaks = compute(&samples, 0, 2, 8);
        assert_eq!(peaks.len(), 8 * VALUES_PER_BUCKET);
        assert!(peaks.chunks(VALUES_PER_BUCKET).all(|b| b[1] >= b[0]));
    }

    #[test]
    fn rms_of_constant_signal_equals_its_magnitude() {
        let samples = vec![0.5f32; 100];
        let peaks = compute(&samples, 0, 100, 1);
        assert!((peaks[2] - 0.5).abs() < 1e-6);
    }
}
