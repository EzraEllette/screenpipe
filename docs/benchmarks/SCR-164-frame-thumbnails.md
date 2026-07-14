# SCR-164 frame thumbnail benchmark

Measured on Windows on 2026-07-13 with the actual Axum frame routes and 24
search-card requests issued concurrently.

## Method

- Source data: 20 existing local snapshot JPEGs, cycled to a 24-card workload.
  Every card had a distinct frame ID, so cycling did not share cache entries.
- Source dimensions: 1728 × 1084.
- Build: Rust development test profile.
- Runs: five, each with a new in-memory database, server state, and thumbnail
  cache. The table reports medians.
- `cold` means a thumbnail derivative-cache miss. `warm` means all 24 requests
  hit the thumbnail cache.
- Elapsed time covers route handling, body collection, and image decoding in
  the benchmark process. Decoded memory is width × height × 4 bytes.

Run the benchmark with:

```powershell
$env:SCREENPIPE_BENCH_DB="$HOME\.screenpipe\db.sqlite"
cargo test -p screenpipe-engine --lib benchmark_real_frame_thumbnail_workload --no-default-features -- --ignored --nocapture
```

## Results

| 24-card batch | Payload | Decoded image memory | Median elapsed | Cache hits |
|---|---:|---:|---:|---:|
| Original 1728 px frames | 4.81 MiB | 171.49 MiB | 109.29 ms | n/a |
| 384 px thumbnails, cold | 0.33 MiB | 8.47 MiB | 39.58 ms | 0/24 |
| 384 px thumbnails, warm | 0.33 MiB | 8.47 MiB | 7.03 ms | 24/24 |
| 768 px thumbnails, cold | 1.12 MiB | 33.89 MiB | 82.46 ms | 0/24 |
| 768 px thumbnails, warm | 1.12 MiB | 33.89 MiB | 23.63 ms | 24/24 |

Compared with original frames:

- 384 px derivatives reduced payload by 93.2% and decoded image memory by
  95.1%. Cold elapsed time was 63.8% lower; warm elapsed time was 93.6% lower.
- 768 px derivatives reduced payload by 76.8% and decoded image memory by
  80.2%. Cold elapsed time was 24.6% lower; warm elapsed time was 78.4% lower.
- Cache hits improved elapsed time by 5.6× at 384 px and 3.5× at 768 px versus
  cold derivative generation.

## Limitations

This isolates image serving and decoding. It does not measure WebView renderer
working set, GPU-process working set, compositor copies, or visual quality at
Windows display scale factors. Those require a packaged before/after app run
with the same query and process-level sampling.
