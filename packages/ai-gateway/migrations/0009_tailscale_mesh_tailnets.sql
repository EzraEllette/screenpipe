-- screenpipe — AI that knows everything you've seen, said, or heard
-- https://screenpipe.com

CREATE TABLE IF NOT EXISTS mesh_tailnets (
    account_namespace TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('provisioning', 'ready')),
    tailnet_id TEXT UNIQUE,
    credentials_ciphertext TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (
        (status = 'provisioning' AND tailnet_id IS NULL AND credentials_ciphertext IS NULL)
        OR
        (status = 'ready' AND tailnet_id IS NOT NULL AND credentials_ciphertext IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_mesh_tailnets_status
ON mesh_tailnets(status);
