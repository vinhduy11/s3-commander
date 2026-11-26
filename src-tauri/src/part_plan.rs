//! Pure multipart part planning: how a file of a given size is cut into S3 parts. No SDK, no I/O.

use crate::app_error::AppError;

/// S3 minimum size of every part except the last.
pub const MIN_PART_BYTES: u64 = 5 << 20;
/// S3 maximum size of one part.
pub const MAX_PART_BYTES: u64 = 5 << 30;
/// S3 maximum size of an object written by one PutObject.
pub const MAX_SINGLE_PUT_BYTES: u64 = 5 << 30;
/// S3 maximum number of parts in one upload.
pub const MAX_PARTS: u64 = 10_000;
/// S3 maximum object size.
pub const MAX_OBJECT_BYTES: u64 = 5 << 40;

/// One part: 1-based number, byte offset in the file and length.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PartSpec {
    pub number: i32,
    pub offset: u64,
    pub length: u64,
}

/// The part size used for `size`: the configured chunk size, raised to the S3 minimum and to
/// whatever keeps the object within 10,000 parts, capped at the S3 maximum part size.
pub fn effective_part_size(size: u64, chunksize: u64) -> u64 {
    chunksize.max(MIN_PART_BYTES).max(size.div_ceil(MAX_PARTS)).min(MAX_PART_BYTES)
}

/// Cut `size` bytes into parts of `effective_part_size`; the last part may be shorter. An empty
/// file has no parts (callers use a plain PutObject for it). Above 5 TiB it is an error.
pub fn plan_parts(size: u64, chunksize: u64) -> Result<Vec<PartSpec>, AppError> {
    if size > MAX_OBJECT_BYTES {
        return Err(AppError::Invalid("the file is above the 5 TiB limit of a single object".into()));
    }
    let part_size = effective_part_size(size, chunksize);
    Ok((0..size.div_ceil(part_size))
        .map(|index| {
            let offset = index * part_size;
            // at most 10,000 parts, so the number always fits
            PartSpec { number: i32::try_from(index + 1).unwrap_or(i32::MAX), offset, length: part_size.min(size - offset) }
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIB: u64 = 1 << 20;

    fn lengths(parts: &[PartSpec]) -> Vec<u64> {
        parts.iter().map(|part| part.length).collect()
    }

    #[test]
    fn empty_file_has_no_parts() {
        assert!(plan_parts(0, 8 * MIB).unwrap().is_empty());
    }

    #[test]
    fn exactly_one_chunk_is_one_part_and_one_byte_more_adds_a_short_last_part() {
        assert_eq!(lengths(&plan_parts(8 * MIB, 8 * MIB).unwrap()), [8 * MIB]);
        assert_eq!(lengths(&plan_parts(8 * MIB + 1, 8 * MIB).unwrap()), [8 * MIB, 1]);
        assert_eq!(lengths(&plan_parts(8 * MIB - 1, 8 * MIB).unwrap()), [8 * MIB - 1]);
    }

    #[test]
    fn parts_are_numbered_from_one_and_cover_the_file_without_gaps() {
        let parts = plan_parts(20 * MIB + 7, 8 * MIB).unwrap();
        assert_eq!(parts.iter().map(|part| part.number).collect::<Vec<_>>(), [1, 2, 3]);
        assert_eq!(parts.iter().map(|part| part.offset).collect::<Vec<_>>(), [0, 8 * MIB, 16 * MIB]);
        assert_eq!(parts.iter().map(|part| part.length).sum::<u64>(), 20 * MIB + 7);
    }

    #[test]
    fn chunk_size_below_the_s3_minimum_is_raised_to_5_mib() {
        assert_eq!(effective_part_size(100 * MIB, MIB), MIN_PART_BYTES);
        assert_eq!(lengths(&plan_parts(11 * MIB, MIB).unwrap()), [5 * MIB, 5 * MIB, MIB]);
    }

    #[test]
    fn chunk_size_is_raised_so_the_object_fits_in_10000_parts() {
        let size = 100 * 1024 * MIB; // 100 GiB with 8 MiB chunks would need 12,800 parts
        let parts = plan_parts(size, 8 * MIB).unwrap();
        assert!(parts.len() as u64 <= MAX_PARTS, "{}", parts.len());
        assert_eq!(effective_part_size(size, 8 * MIB), size.div_ceil(MAX_PARTS));
        assert_eq!(parts.iter().map(|part| part.length).sum::<u64>(), size);
        // exactly at the boundary the configured size is kept
        assert_eq!(plan_parts(8 * MIB * MAX_PARTS, 8 * MIB).unwrap().len() as u64, MAX_PARTS);
        assert_eq!(plan_parts(8 * MIB * MAX_PARTS + 1, 8 * MIB).unwrap()[0].length, 8 * MIB + 1);
    }

    #[test]
    fn a_part_never_exceeds_5_gib() {
        assert_eq!(effective_part_size(MAX_OBJECT_BYTES, 8 << 30), MAX_PART_BYTES);
    }

    #[test]
    fn five_tib_is_the_largest_object_and_fits_in_10000_parts() {
        let parts = plan_parts(MAX_OBJECT_BYTES, 8 * MIB).unwrap();
        assert!(parts.len() as u64 <= MAX_PARTS);
        assert!(parts.iter().all(|part| part.length <= MAX_PART_BYTES));
        assert_eq!(parts.iter().map(|part| part.length).sum::<u64>(), MAX_OBJECT_BYTES);
        let err = plan_parts(MAX_OBJECT_BYTES + 1, 8 * MIB).unwrap_err();
        assert!(matches!(err, AppError::Invalid(_)) && err.to_string().contains("5 TiB"), "{err}");
    }
}
