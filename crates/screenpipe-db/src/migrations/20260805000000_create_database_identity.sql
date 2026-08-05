CREATE TABLE database_identity (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    generation_id TEXT NOT NULL UNIQUE
);

INSERT INTO database_identity (singleton, generation_id)
VALUES (1, lower(hex(randomblob(16))));