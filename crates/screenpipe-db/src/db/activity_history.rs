// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

use chrono::{DateTime, Utc};
use sqlx::{Error as SqlxError, FromRow};

use super::DatabaseManager;
use crate::Order;

#[derive(Debug, Clone, FromRow)]
pub struct ActivityHistoryRecord {
    pub id: String,
    pub producer: String,
    pub kind: String,
    pub meeting_id: Option<i64>,
    pub start_at: DateTime<Utc>,
    pub end_at: DateTime<Utc>,
    pub title: String,
    pub summary: String,
    pub evidence_json: String,
    pub updated_at: DateTime<Utc>,
}

impl DatabaseManager {
    /// Replace the searchable projection for one Activity History producer.
    ///
    /// Activity generation validates and persists the complete producer
    /// document before calling this method. Replacing it in one transaction
    /// prevents API clients from observing a half-updated projection.
    pub async fn replace_activity_history(
        &self,
        producer: &str,
        entries: &[ActivityHistoryRecord],
    ) -> Result<(), SqlxError> {
        let mut tx = self.begin_immediate_with_retry().await?;
        sqlx::query("DELETE FROM activity_history_entries WHERE producer = ?1")
            .bind(producer)
            .execute(&mut **tx.conn())
            .await?;

        for entry in entries.iter().filter(|entry| entry.producer == producer) {
            sqlx::query(
                r#"INSERT INTO activity_history_entries
                   (id, producer, kind, meeting_id, start_at, end_at, title,
                    summary, evidence_json, updated_at)
                   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)"#,
            )
            .bind(&entry.id)
            .bind(&entry.producer)
            .bind(&entry.kind)
            .bind(entry.meeting_id)
            .bind(entry.start_at)
            .bind(entry.end_at)
            .bind(&entry.title)
            .bind(&entry.summary)
            .bind(&entry.evidence_json)
            .bind(entry.updated_at)
            .execute(&mut **tx.conn())
            .await?;
        }

        tx.commit().await
    }

    pub async fn search_activity_history(
        &self,
        query: &str,
        limit: u32,
        offset: u32,
        start_time: Option<DateTime<Utc>>,
        end_time: Option<DateTime<Utc>>,
        order: Order,
    ) -> Result<Vec<ActivityHistoryRecord>, SqlxError> {
        let order_direction = match order {
            Order::Ascending => "ASC",
            Order::Descending => "DESC",
        };
        let sql = format!(
            r#"SELECT id, producer, kind, meeting_id, start_at, end_at, title,
                      summary, evidence_json, updated_at
               FROM activity_history_entries
               WHERE (?1 = '' OR instr(lower(title || char(10) || summary), lower(?1)) > 0)
                 AND (?2 IS NULL OR end_at > ?2)
                 AND (?3 IS NULL OR start_at < ?3)
               ORDER BY start_at {order_direction}, id {order_direction}
               LIMIT ?4 OFFSET ?5"#,
        );
        sqlx::query_as::<_, ActivityHistoryRecord>(sqlx::AssertSqlSafe(sql))
            .bind(query)
            .bind(start_time)
            .bind(end_time)
            .bind(limit)
            .bind(offset)
            .fetch_all(&self.pool)
            .await
    }

    pub async fn count_activity_history(
        &self,
        query: &str,
        start_time: Option<DateTime<Utc>>,
        end_time: Option<DateTime<Utc>>,
    ) -> Result<usize, SqlxError> {
        let count: i64 = sqlx::query_scalar(
            r#"SELECT COUNT(*)
               FROM activity_history_entries
               WHERE (?1 = '' OR instr(lower(title || char(10) || summary), lower(?1)) > 0)
                 AND (?2 IS NULL OR end_at > ?2)
                 AND (?3 IS NULL OR start_at < ?3)"#,
        )
        .bind(query)
        .bind(start_time)
        .bind(end_time)
        .fetch_one(&self.pool)
        .await?;
        Ok(count.max(0) as usize)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use screenpipe_config::DbConfig;

    async fn test_db() -> (DatabaseManager, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let db = DatabaseManager::new(
            dir.path().join("db.sqlite").to_str().unwrap(),
            DbConfig::default(),
        )
        .await
        .unwrap();
        (db, dir)
    }

    fn record(id: &str, start_at: &str, title: &str, summary: &str) -> ActivityHistoryRecord {
        ActivityHistoryRecord {
            id: id.to_string(),
            producer: "activity-history-pi-v9".to_string(),
            kind: "work".to_string(),
            meeting_id: None,
            start_at: start_at.parse().unwrap(),
            end_at: (start_at.parse::<DateTime<Utc>>().unwrap() + chrono::Duration::minutes(20)),
            title: title.to_string(),
            summary: summary.to_string(),
            evidence_json:
                r#"[{"kind":"screen","at":"2026-08-20T09:05:00Z","frame_id":42,"label":"PR"}]"#
                    .to_string(),
            updated_at: "2026-08-20T10:00:00Z".parse().unwrap(),
        }
    }

    #[tokio::test]
    async fn replace_and_search_activity_history() {
        let (db, _dir) = test_db().await;
        db.replace_activity_history(
            "activity-history-pi-v9",
            &[
                record(
                    "review-pr",
                    "2026-08-20T09:00:00Z",
                    "Reviewed pull request",
                    "Checked the Activity search implementation.",
                ),
                record(
                    "planning",
                    "2026-08-20T10:00:00Z",
                    "Planned release",
                    "Prepared the rollout checklist.",
                ),
            ],
        )
        .await
        .unwrap();

        let results = db
            .search_activity_history(
                "activity search",
                20,
                0,
                Some("2026-08-20T08:00:00Z".parse().unwrap()),
                Some("2026-08-20T11:00:00Z".parse().unwrap()),
                Order::Descending,
            )
            .await
            .unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].id, "review-pr");
        assert_eq!(db.count_activity_history("", None, None).await.unwrap(), 2);

        db.replace_activity_history(
            "activity-history-pi-v9",
            &[record(
                "planning",
                "2026-08-20T10:00:00Z",
                "Planned release",
                "Prepared the revised rollout checklist.",
            )],
        )
        .await
        .unwrap();
        assert_eq!(db.count_activity_history("", None, None).await.unwrap(), 1);
    }
}
