-- screenpipe — AI that knows everything you've seen, said, or heard
-- https://screenpipe.com

-- Searchable projection of the validated Activity History shown by the app.
-- The encrypted app store remains the source of truth; the native app replaces
-- this projection after generation and at startup so local API clients can read
-- the same interpreted work history without opening store.bin.
CREATE TABLE activity_history_entries (
    id TEXT NOT NULL,
    producer TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('work', 'meeting')),
    meeting_id INTEGER,
    start_at TEXT NOT NULL,
    end_at TEXT NOT NULL,
    title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 512),
    summary TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 4096),
    evidence_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence_json)),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (producer, id),
    CHECK (julianday(end_at) > julianday(start_at))
);

CREATE INDEX idx_activity_history_entries_range
    ON activity_history_entries(start_at, end_at, id);

CREATE INDEX idx_activity_history_entries_producer_range
    ON activity_history_entries(producer, start_at, end_at, id);
