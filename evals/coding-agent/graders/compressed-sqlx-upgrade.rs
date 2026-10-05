// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

use screenpipe_db::storage::{Projection, StorageMode};
use screenpipe_db::{ContentType, DatabaseManager};
use sqlx::Connection;

async fn seed(db: &DatabaseManager, id: i64, text: Option<&str>, accessibility: Option<&str>) {
    let mut tx = db.begin_immediate_with_retry().await.unwrap();
    sqlx::query("INSERT INTO frames(id,timestamp,full_text,accessibility_text,text_json,accessibility_tree_json,app_name,window_name,device_name) VALUES(?,'2026-09-11T12:00:00Z',?,?,'[{\"text\":\"hello\",\"left\":0.5}]','{\"text\":\"hello\"}','Editor','notes','display')")
        .bind(id).bind(text).bind(accessibility).execute(&mut **tx.conn()).await.unwrap();
    tx.commit().await.unwrap();
}

async fn search(db: &DatabaseManager, query: &str) -> serde_json::Value {
    let results = db
        .search(
            query,
            ContentType::OCR,
            100,
            0,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();
    serde_json::to_value(results).unwrap()
}

#[tokio::test]
async fn starred_upgrade_restores_older_hybrid_search_and_preserves_recordings() {
    let root = tempfile::tempdir().unwrap();
    let db = DatabaseManager::new_hybrid(root.path(), Default::default(), Default::default())
        .await
        .unwrap();
    seed(&db, 1, Some("starred upgrade history"), None).await;
    db.seal_frame_payloads().await.unwrap();
    let before = db.frame_payloads(&[1], Projection::All).await.unwrap();
    // Reproduce a generation converted before starred sessions shipped. Only
    // mutate this disposable fixture, through its existing serialized writer.
    db.execute_raw_sql_write(
        "DROP TABLE starred_sessions;
         DELETE FROM _sqlx_migrations WHERE version=20261002190000;",
    )
    .await
    .unwrap();
    db.close().await;

    let start = "2026-09-11T12:00:00.000Z";
    let end = "2026-09-11T12:15:00.000Z";
    for reopen in 0..2 {
        let db = DatabaseManager::new(
            root.path().join("db.sqlite").to_str().unwrap(),
            Default::default(),
        )
        .await
        .unwrap();
        assert_eq!(db.storage_mode(), StorageMode::HybridParquetV1);
        db.verify_storage().await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT count(*) FROM _sqlx_migrations WHERE version=20261002190000 AND success=1"
            )
            .fetch_one(&db.pool)
            .await
            .unwrap(),
            1,
        );
        assert_eq!(
            before,
            db.frame_payloads(&[1], Projection::All).await.unwrap()
        );
        assert_eq!(search(&db, "history").await.as_array().unwrap().len(), 1);
        assert_eq!(
            db.list_starred_sessions(start, end, 10, 0)
                .await
                .unwrap()
                .len(),
            reopen,
        );
        // Search response assembly calls this even without a starred filter.
        assert_eq!(
            db.starred_timestamps(&[start.into(), end.into()])
                .await
                .unwrap(),
            vec![reopen == 1, false],
        );
        assert!(db.starred_timestamps(&[]).await.unwrap().is_empty());
        if reopen == 0 {
            assert!(db
                .save_starred_session("upgrade", start, end, false, 0, start)
                .await
                .unwrap());
            seed(&db, 2, Some("continued capture"), None).await;
            db.seal_frame_payloads().await.unwrap();
        } else {
            assert_eq!(
                db.get_starred_session("upgrade")
                    .await
                    .unwrap()
                    .unwrap()
                    .revision,
                1
            );
            assert_eq!(
                db.starred_search_ranges(start, end).await.unwrap(),
                vec![(start.into(), end.into())]
            );
            assert_eq!(search(&db, "continued").await.as_array().unwrap().len(), 1);
        }
        db.close().await;
    }
}

#[tokio::test]
async fn starred_upgrade_preserves_existing_sessions_and_tracks_mutations() {
    let root = tempfile::tempdir().unwrap();
    let db = DatabaseManager::new_hybrid(root.path(), Default::default(), Default::default())
        .await
        .unwrap();
    let start = "2026-09-11T12:00:00.000Z";
    let end = "2026-09-11T12:15:00.000Z";
    assert!(db
        .save_starred_session("existing", start, end, true, 0, start)
        .await
        .unwrap());
    // Already-applied SQLx migrations must preserve their data; missing
    // generic storage hooks can still be installed without replaying the DDL.
    db.execute_raw_sql_write(
        "DROP TRIGGER IF EXISTS hybrid_revision_starred_sessions_INSERT;
         DROP TRIGGER IF EXISTS hybrid_revision_starred_sessions_UPDATE;
         DROP TRIGGER IF EXISTS hybrid_revision_starred_sessions_DELETE;
         DROP TRIGGER IF EXISTS hybrid_read_revoke_delete_starred_sessions;",
    )
    .await
    .unwrap();
    db.close().await;

    for _ in 0..2 {
        let db = DatabaseManager::new(
            root.path().join("db.sqlite").to_str().unwrap(),
            Default::default(),
        )
        .await
        .unwrap();
        let session = db.get_starred_session("existing").await.unwrap().unwrap();
        assert_eq!(session.revision, 1);
        assert!(session.hd_requested);
        let before = db.storage_read_token().await.unwrap().revision;
        assert!(db
            .save_starred_session("temporary", end, "2026-09-11T12:30:00.000Z", false, 0, end)
            .await
            .unwrap());
        assert_eq!(db.storage_read_token().await.unwrap().revision, before + 1);
        assert!(db
            .save_starred_session("temporary", end, "2026-09-11T12:45:00.000Z", false, 1, end)
            .await
            .unwrap());
        assert_eq!(db.storage_read_token().await.unwrap().revision, before + 2);
        let revocation: i64 =
            sqlx::query_scalar("SELECT revision FROM _storage_revocation WHERE id=1")
                .fetch_one(&db.pool)
                .await
                .unwrap();
        db.execute_raw_sql_write("DELETE FROM starred_sessions WHERE id='temporary'")
            .await
            .unwrap();
        assert_eq!(db.storage_read_token().await.unwrap().revision, before + 3);
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT revision FROM _storage_revocation WHERE id=1")
                .fetch_one(&db.pool)
                .await
                .unwrap(),
            revocation + 1
        );
        db.close().await;
    }
}

#[tokio::test]
async fn later_resident_tables_receive_storage_and_privacy_hooks() {
    let root = tempfile::tempdir().unwrap();
    let db = DatabaseManager::new_hybrid(root.path(), Default::default(), Default::default())
        .await
        .unwrap();
    // A future resident feature needs no feature-specific Rust upgrade.
    db.execute_raw_sql_write(
        "CREATE TABLE feature_notes(id INTEGER PRIMARY KEY, text TEXT, redacted_at TEXT);",
    )
    .await
    .unwrap();
    db.close().await;
    for _ in 0..2 {
        let db = DatabaseManager::new(
            root.path().join("db.sqlite").to_str().unwrap(),
            Default::default(),
        )
        .await
        .unwrap();
        let before = db.storage_read_token().await.unwrap().revision;
        db.execute_raw_sql_write("INSERT INTO feature_notes VALUES(1,'private',NULL)")
            .await
            .unwrap();
        assert_eq!(db.storage_read_token().await.unwrap().revision, before + 1);
        let token = db.read_snapshot(db.storage_read_token()).await.unwrap().unwrap();
        db.execute_raw_sql_write("UPDATE feature_notes SET text='ordinary edit' WHERE id=1")
            .await
            .unwrap();
        drop(token.admit(&db.pool).await.expect("ordinary edits preserve the read snapshot"));
        db.execute_raw_sql_write(
            "UPDATE feature_notes SET text='redacted',redacted_at='2026-10-03' WHERE id=1",
        )
        .await
        .unwrap();
        assert!(token.admit(&db.pool).await.is_err());
        drop(token);
        assert_eq!(db.storage_read_token().await.unwrap().revision, before + 3);
        let token = db.read_snapshot(db.storage_read_token()).await.unwrap().unwrap();
        db.execute_raw_sql_write("DELETE FROM feature_notes WHERE id=1")
            .await
            .unwrap();
        assert!(token.admit(&db.pool).await.is_err());
        drop(token);
        assert_eq!(db.storage_read_token().await.unwrap().revision, before + 4);
        db.close().await;
    }
}

#[tokio::test]
async fn pending_sqlx_migration_rolls_back_and_retries_on_compressed_storage() {
    use screenpipe_db::storage::StorageDescriptor;
    let root = tempfile::tempdir().unwrap();
    let db = DatabaseManager::new_hybrid(root.path(), Default::default(), Default::default())
        .await
        .unwrap();
    seed(&db, 1, Some("migration retry history"), None).await;
    db.seal_frame_payloads().await.unwrap();
    let before = db.frame_payloads(&[1], Projection::All).await.unwrap();
    // Fail the second statement of the pending migration, after CREATE TABLE.
    db.execute_raw_sql_write(
        "DROP TABLE starred_sessions;
         DELETE FROM _sqlx_migrations WHERE version=20261002190000;
         CREATE INDEX idx_starred_sessions_start_end ON tags(name);",
    )
    .await
    .unwrap();
    db.close().await;
    let path = root.path().join("db.sqlite");
    let error = match DatabaseManager::new(path.to_str().unwrap(), Default::default()).await {
        Ok(db) => {
            db.close().await;
            panic!("conflicting index must fail startup");
        }
        Err(error) => error.to_string(),
    };
    assert!(error.contains("idx_starred_sessions_start_end"), "{error}");
    // Inspect only this closed, disposable index. SQLx must roll back both DDL
    // and its completion record before a corrected retry can proceed.
    let descriptor = StorageDescriptor::read(root.path()).unwrap().unwrap();
    let mut conn = sqlx::SqliteConnection::connect_with(
        &sqlx::sqlite::SqliteConnectOptions::new().filename(root.path().join(descriptor.index)),
    )
    .await
    .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM sqlite_master WHERE name='starred_sessions'"
        )
        .fetch_one(&mut conn)
        .await
        .unwrap(),
        0
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM _sqlx_migrations WHERE version=20261002190000"
        )
        .fetch_one(&mut conn)
        .await
        .unwrap(),
        0
    );
    sqlx::query("DROP INDEX idx_starred_sessions_start_end")
        .execute(&mut conn)
        .await
        .unwrap();
    conn.close().await.unwrap();
    let db = DatabaseManager::new(path.to_str().unwrap(), Default::default())
        .await
        .unwrap();
    db.verify_storage().await.unwrap();
    assert_eq!(
        before,
        db.frame_payloads(&[1], Projection::All).await.unwrap()
    );
    assert_eq!(search(&db, "history").await.as_array().unwrap().len(), 1);
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM _sqlx_migrations WHERE version=20261002190000 AND success=1"
        )
        .fetch_one(&db.pool)
        .await
        .unwrap(),
        1
    );
    db.close().await;
}

#[tokio::test]
async fn ordinary_sqlite_starred_sessions_remain_available() {
    let root = tempfile::tempdir().unwrap();
    let db = DatabaseManager::new(root.path().join("db.sqlite").to_str().unwrap(), Default::default()).await.unwrap();
    let start="2026-09-11T12:00:00.000Z";
    let end="2026-09-11T12:15:00.000Z";
    assert!(db.save_starred_session("ordinary", start, end, false, 0, start).await.unwrap());
    assert_eq!(db.get_starred_session("ordinary").await.unwrap().unwrap().revision, 1);
    assert_eq!(db.starred_timestamps(&[start.into(),end.into()]).await.unwrap(),vec![true,false]);
    db.close().await;
}

#[tokio::test]
async fn existing_compressed_payloads_and_new_capture_survive_restart() {
    let root = tempfile::tempdir().unwrap();
    let db = DatabaseManager::new_hybrid(root.path(), Default::default(), Default::default()).await.unwrap();
    seed(&db, 1, Some("preserved café 東京"), None).await;
    db.seal_frame_payloads().await.unwrap();
    let before = db.frame_payloads(&[1], Projection::All).await.unwrap();
    db.close().await;
    let db = DatabaseManager::new(root.path().join("db.sqlite").to_str().unwrap(), Default::default()).await.unwrap();
    db.verify_storage().await.unwrap();
    assert_eq!(before,db.frame_payloads(&[1],Projection::All).await.unwrap());
    assert_eq!(search(&db,"preserved").await.as_array().unwrap().len(),1);
    seed(&db,2,Some("continued capture"),None).await;
    db.seal_frame_payloads().await.unwrap();
    assert_eq!(search(&db,"continued").await.as_array().unwrap().len(),1);
    db.close().await;
}
