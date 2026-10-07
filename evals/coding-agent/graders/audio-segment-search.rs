// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
use chrono::{DateTime, Utc};
use screenpipe_db::{AudioDevice, AudioResult, DatabaseManager, DeviceType, Order, TagContentType};

struct Fixture {
    _dir: tempfile::TempDir,
    db: DatabaseManager,
    snapshot: Vec<(i64, String, i64, f64, f64)>,
}
async fn snapshot(db: &DatabaseManager) -> Vec<(i64, String, i64, f64, f64)> {
    sqlx::query_as("SELECT id,transcription,offset_index,start_time,end_time FROM audio_transcriptions ORDER BY id")
        .fetch_all(&db.pool).await.unwrap()
}
async fn fixture(shared_offset: bool, tagged: bool, same_text: bool) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let db = DatabaseManager::new(dir.path().join("synthetic.sqlite").to_str().unwrap(), Default::default()).await.unwrap();
    let chunk = db.insert_audio_chunk("synthetic-speech.mp4", None).await.unwrap();
    let device = AudioDevice { name: "Synthetic Output".into(), device_type: DeviceType::Output };
    let captured = DateTime::parse_from_rfc3339("2026-01-02T12:00:00Z").unwrap().with_timezone(&Utc);
    for (i, text) in ["first note", "second statement", "third phrase"].iter().enumerate() {
        let segment_chunk = if same_text { db.insert_audio_chunk(&format!("synthetic-{i}.mp4"), None).await.unwrap() } else { chunk };
        db.insert_audio_transcription(segment_chunk, text,
            if shared_offset { 0 } else { i as i64 }, "synthetic", &device, None,
            Some(i as f64 * 2.0), Some(i as f64 * 2.0 + 2.0), Some(captured)).await.unwrap();
        if same_text { assert_eq!(db.update_audio_transcription(segment_chunk, "repeated words").await.unwrap(), 1); }
    }
    if tagged { db.add_tags(chunk, TagContentType::Audio, vec!["juniper".into(), "review".into()]).await.unwrap(); }
    let before = snapshot(&db).await;
    assert_eq!(before.len(), 3, "synthetic setup must retain three distinct stored rows");
    Fixture { _dir: dir, db, snapshot: before }
}
async fn read(f: &Fixture, order: Order, limit: u32, offset: u32) -> Vec<AudioResult> {
    f.db.search_audio_ordered("", limit, offset, None, None, None, None, None, None, None, None, &[], order).await.unwrap()
}
fn segments(rows: &[AudioResult]) -> Vec<String> { rows.iter().map(|r| r.transcription.clone()).collect() }
async fn unchanged(f: &Fixture) { assert_eq!(snapshot(&f.db).await, f.snapshot); }

#[tokio::test]
async fn distinct_segments_with_shared_chunk_offset_and_timestamp_survive() {
    let f = fixture(true, false, false).await;
    let rows = read(&f, Order::Ascending, 20, 0).await;
    assert_eq!(segments(&rows), vec!["first note", "second statement", "third phrase"]);
    for (i, row) in rows.iter().enumerate() {
        assert_eq!(row.start_time, Some(i as f64 * 2.0));
        assert_eq!(row.end_time, Some(i as f64 * 2.0 + 2.0));
        assert!(row.tags.is_empty());
    }
    unchanged(&f).await;
}
#[tokio::test]
async fn tag_joins_do_not_duplicate_tags_or_merge_speech() {
    let f = fixture(true, true, false).await;
    let rows = read(&f, Order::Ascending, 20, 0).await;
    assert_eq!(rows.len(), 3);
    for row in rows { let mut tags = row.tags; tags.sort(); assert_eq!(tags, vec!["juniper", "review"]); }
    unchanged(&f).await;
}
#[tokio::test]
async fn tied_segments_paginate_once_in_both_directions() {
    let f = fixture(true, true, false).await;
    for (order, expected) in [(Order::Ascending, vec!["first note", "second statement", "third phrase"]),
        (Order::Descending, vec!["third phrase", "second statement", "first note"])] {
        let mut actual = Vec::new();
        for offset in 0..4 { actual.extend(segments(&read(&f, order, 1, offset).await)); }
        assert_eq!(actual, expected);
    }
    unchanged(&f).await;
}
#[tokio::test]
async fn identical_words_in_distinct_segments_are_not_deduplicated() {
    let f = fixture(true, false, true).await;
    let rows = read(&f, Order::Ascending, 20, 0).await;
    assert_eq!(segments(&rows), vec!["repeated words"; 3]);
    assert_eq!(rows.iter().map(|r| r.start_time).collect::<Vec<_>>(), vec![Some(0.0), Some(2.0), Some(4.0)]);
    unchanged(&f).await;
}
#[tokio::test]
async fn ordinary_offsets_preserve_filters_and_metadata() {
    let f = fixture(false, true, false).await;
    let tags = vec!["juniper".to_string(), "review".to_string()];
    let rows = f.db.search_audio_ordered("", 20, 0, None, None, Some(11), Some(13), None, None,
        Some("Synthetic Output"), None, &tags, Order::Ascending).await.unwrap();
    assert_eq!(segments(&rows), vec!["third phrase"]);
    assert_eq!(rows[0].start_time, Some(4.0));
    let missing = vec!["juniper".to_string(), "missing".to_string()];
    assert!(f.db.search_audio_ordered("", 20, 0, None, None, None, None, None, None, None, None, &missing, Order::Ascending).await.unwrap().is_empty());
    assert!(f.db.search_audio_ordered("", 20, 0, None, None, None, None, None, None, Some("Unknown Device"), None, &[], Order::Ascending).await.unwrap().is_empty());
    unchanged(&f).await;
}
#[tokio::test]
async fn empty_results_and_read_only_behavior_are_preserved() {
    let f = fixture(false, false, false).await;
    assert!(read(&f, Order::Ascending, 0, 0).await.is_empty());
    assert!(read(&f, Order::Descending, 10, 10).await.is_empty());
    assert!(f.db.search_audio_ordered("absentword", 20, 0, None, None, None, None, None, None, None, None, &[], Order::Ascending).await.unwrap().is_empty());
    let future = DateTime::parse_from_rfc3339("2026-02-01T00:00:00Z").unwrap().with_timezone(&Utc);
    assert!(f.db.search_audio_ordered("", 20, 0, Some(future), None, None, None, None, None, None, None, &[], Order::Ascending).await.unwrap().is_empty());
    assert_eq!(segments(&read(&f, Order::Ascending, 1, 1).await), vec!["second statement"]);
    unchanged(&f).await;
}
