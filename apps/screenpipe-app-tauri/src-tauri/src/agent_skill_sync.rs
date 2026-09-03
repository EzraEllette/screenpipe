// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Opt-in projection of canonical Screenpipe skills into local agent skill dirs.
//!
//! The canonical store remains `<data_dir>/skills`. Only manifest-proven,
//! enabled agent-created skills project automatically. User/imported skills
//! require an explicit per-skill destination. A private receipt records every
//! copy Screenpipe owns; changed or unowned destinations are conflicts and are
//! never overwritten or removed without an explicit resolution.

use notify::{RecursiveMode, Watcher};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use specta::Type;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tracing::{info, warn};

const MANIFEST_SCHEMA: u8 = 1;
const MANIFEST_FILE: &str = "agent-skill-sync-v1.json";
const MAX_SKILL_FILES: usize = 300;
const MAX_SKILL_FILE_BYTES: u64 = 10 * 1024 * 1024;
const MAX_SKILL_TOTAL_BYTES: u64 = 40 * 1024 * 1024;

static SYNC_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);
static WATCHER_STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[derive(Clone, Copy)]
struct TargetDefinition {
    id: &'static str,
    name: &'static str,
}

const TARGETS: [TargetDefinition; 7] = [
    TargetDefinition {
        id: "claude",
        name: "Claude",
    },
    TargetDefinition {
        id: "codex",
        name: "Codex",
    },
    TargetDefinition {
        id: "cursor",
        name: "Cursor",
    },
    TargetDefinition {
        id: "gemini",
        name: "Gemini CLI",
    },
    TargetDefinition {
        id: "opencode",
        name: "OpenCode",
    },
    TargetDefinition {
        id: "openclaw",
        name: "OpenClaw",
    },
    TargetDefinition {
        id: "hermes",
        name: "Hermes",
    },
];

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SyncManifest {
    schema: u8,
    #[serde(default)]
    enabled_targets: BTreeSet<String>,
    #[serde(default)]
    shared_skills: BTreeMap<String, BTreeSet<String>>,
    #[serde(default)]
    receipts: BTreeMap<String, BTreeMap<String, SyncReceipt>>,
    #[serde(default)]
    issues: BTreeMap<String, BTreeMap<String, PersistedIssue>>,
    #[serde(default)]
    pending_operation: Option<PendingSyncOperation>,
}

impl Default for SyncManifest {
    fn default() -> Self {
        Self {
            schema: MANIFEST_SCHEMA,
            enabled_targets: BTreeSet::new(),
            shared_skills: BTreeMap::new(),
            receipts: BTreeMap::new(),
            issues: BTreeMap::new(),
            pending_operation: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct SyncReceipt {
    source_digest: String,
    installed_digest: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct PersistedIssue {
    kind: AgentSkillSyncIssueKind,
    message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum PendingSyncOperationKind {
    Replace,
    ManagedRemoval,
    ExplicitRemoval,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum PendingSyncOperationPhase {
    Prepared,
    Committed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PendingSyncOperation {
    target: String,
    skill_key: String,
    kind: PendingSyncOperationKind,
    phase: PendingSyncOperationPhase,
    backup_name: String,
    previous_digest: String,
    #[serde(default)]
    previous_receipt: Option<SyncReceipt>,
    #[serde(default)]
    source_digest: Option<String>,
    #[serde(default)]
    installed_digest: Option<String>,
    #[serde(default)]
    previous_issue: Option<PersistedIssue>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentSkillSyncIssueKind {
    Conflict,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentSkillSyncScreenpipeResolution {
    ReplaceWithScreenpipe,
    RemoveAgentCopy,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentSkillSyncIssue {
    pub target: String,
    pub target_name: String,
    pub skill_key: String,
    pub skill_name: String,
    pub canonical_exists: bool,
    pub screenpipe_resolution: AgentSkillSyncScreenpipeResolution,
    pub kind: AgentSkillSyncIssueKind,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentSkillSyncTarget {
    pub id: String,
    pub name: String,
    pub detected: bool,
    pub enabled: bool,
    pub synced_count: u64,
    pub issue_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentSkillSyncSkill {
    pub key: String,
    pub automatic: bool,
    pub selected_targets: Vec<String>,
    pub synced_targets: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentSkillSyncSnapshot {
    pub targets: Vec<AgentSkillSyncTarget>,
    pub skills: Vec<AgentSkillSyncSkill>,
    pub issues: Vec<AgentSkillSyncIssue>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum AgentSkillSyncConflictResolution {
    ReplaceWithScreenpipe,
    ImportAsNewSkill,
}

#[derive(Clone)]
struct StoreSkill {
    key: String,
    name: String,
    description: String,
    origin: String,
    path: PathBuf,
    enabled: bool,
}

struct SyncStoreSnapshot {
    skills: Vec<StoreSkill>,
    pending_install_keys: BTreeSet<String>,
}

#[derive(Clone)]
struct SkillFile {
    relative: PathBuf,
    source: PathBuf,
    bytes: u64,
}

struct SkillCopyError {
    kind: AgentSkillSyncIssueKind,
    message: String,
    recovery_pending: bool,
}

#[derive(Clone, Copy)]
enum ExistingDestinationPolicy<'a> {
    MustBeAbsent,
    Managed(&'a str),
    ReplaceExplicitly,
}

struct SyncJournalContext<'a> {
    target: &'a str,
    manifest_path: &'a Path,
    manifest: &'a mut SyncManifest,
}

impl SkillCopyError {
    fn error(message: impl Into<String>) -> Self {
        Self {
            kind: AgentSkillSyncIssueKind::Error,
            message: message.into(),
            recovery_pending: false,
        }
    }

    fn conflict(message: impl Into<String>) -> Self {
        Self {
            kind: AgentSkillSyncIssueKind::Conflict,
            message: message.into(),
            recovery_pending: false,
        }
    }

    fn unresolved(message: impl Into<String>) -> Self {
        Self {
            kind: AgentSkillSyncIssueKind::Error,
            message: message.into(),
            recovery_pending: true,
        }
    }
}

fn target_definition(id: &str) -> Result<TargetDefinition, String> {
    TARGETS
        .iter()
        .copied()
        .find(|target| target.id == id)
        .ok_or_else(|| format!("unsupported skill sync target: {id}"))
}

fn valid_skill_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 80
        && key.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-' || byte == b'_'
        })
}

fn valid_portable_skill_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 64
        && !key.starts_with('-')
        && !key.ends_with('-')
        && !key.contains("--")
        && key
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn valid_digest(digest: &str) -> bool {
    digest.len() == 64
        && digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_issue_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 255
        && key != "."
        && key != ".."
        && !key.contains('/')
        && !key.contains('\\')
        && !key.chars().any(char::is_control)
}

fn valid_recovery_backup_name(key: &str, name: &str) -> bool {
    if name.len() > 160 || Path::new(name).file_name().and_then(|part| part.to_str()) != Some(name)
    {
        return false;
    }
    let Some(sequence) = name.strip_prefix(&format!(".{key}.screenpipe-recovery-")) else {
        return false;
    };
    let mut parts = sequence.split('-');
    matches!(
        (parts.next(), parts.next(), parts.next()),
        (Some(pid), Some(counter), None)
            if !pid.is_empty()
                && !counter.is_empty()
                && pid.bytes().all(|byte| byte.is_ascii_digit())
                && counter.bytes().all(|byte| byte.is_ascii_digit())
    )
}

fn validate_manifest(manifest: &SyncManifest) -> Result<(), String> {
    if manifest.schema != MANIFEST_SCHEMA {
        return Err("skill sync settings use an unsupported schema".to_string());
    }
    let valid_target = |target: &str| TARGETS.iter().any(|definition| definition.id == target);
    if manifest
        .enabled_targets
        .iter()
        .any(|target| !valid_target(target))
    {
        return Err("skill sync settings contain an unsupported target".to_string());
    }
    for (key, targets) in manifest.shared_skills.iter() {
        if !valid_skill_key(key) || targets.iter().any(|target| !valid_target(target)) {
            return Err("skill sync settings contain an invalid skill selection".to_string());
        }
    }
    for (target, receipts) in &manifest.receipts {
        if !valid_target(target) {
            return Err("skill sync settings contain an unsupported receipt target".to_string());
        }
        for (key, receipt) in receipts {
            if !valid_skill_key(key)
                || !valid_digest(&receipt.source_digest)
                || !valid_digest(&receipt.installed_digest)
            {
                return Err("skill sync settings contain an invalid receipt".to_string());
            }
        }
    }
    for (target, issues) in &manifest.issues {
        if !valid_target(target) || issues.keys().any(|key| !valid_issue_key(key)) {
            return Err("skill sync settings contain an invalid issue record".to_string());
        }
    }
    if let Some(operation) = manifest.pending_operation.as_ref() {
        if !valid_target(&operation.target)
            || !valid_skill_key(&operation.skill_key)
            || !valid_recovery_backup_name(&operation.skill_key, &operation.backup_name)
            || !valid_digest(&operation.previous_digest)
        {
            return Err("skill sync settings contain an invalid recovery record".to_string());
        }
        let replacement_digests_valid =
            operation.source_digest.as_deref().is_some_and(valid_digest)
                && operation
                    .installed_digest
                    .as_deref()
                    .is_some_and(valid_digest);
        if operation.previous_receipt.as_ref().is_some_and(|receipt| {
            !valid_digest(&receipt.source_digest) || !valid_digest(&receipt.installed_digest)
        }) {
            return Err("skill sync settings contain an invalid recovery record".to_string());
        }
        match operation.kind {
            PendingSyncOperationKind::Replace if !replacement_digests_valid => {
                return Err("skill sync settings contain an invalid recovery record".to_string());
            }
            PendingSyncOperationKind::ManagedRemoval
            | PendingSyncOperationKind::ExplicitRemoval
                if operation.source_digest.is_some() || operation.installed_digest.is_some() =>
            {
                return Err("skill sync settings contain an invalid recovery record".to_string());
            }
            _ => {}
        }
        let current_receipt = manifest
            .receipts
            .get(&operation.target)
            .and_then(|receipts| receipts.get(&operation.skill_key));
        let receipt_state_valid = match (&operation.phase, &operation.kind) {
            (PendingSyncOperationPhase::Prepared, _) => {
                current_receipt == operation.previous_receipt.as_ref()
            }
            (PendingSyncOperationPhase::Committed, PendingSyncOperationKind::Replace) => {
                current_receipt.is_some_and(|receipt| {
                    Some(receipt.source_digest.as_str()) == operation.source_digest.as_deref()
                        && Some(receipt.installed_digest.as_str())
                            == operation.installed_digest.as_deref()
                })
            }
            (
                PendingSyncOperationPhase::Committed,
                PendingSyncOperationKind::ManagedRemoval
                | PendingSyncOperationKind::ExplicitRemoval,
            ) => current_receipt.is_none(),
        };
        let managed_removal_valid = operation.kind != PendingSyncOperationKind::ManagedRemoval
            || operation
                .previous_receipt
                .as_ref()
                .is_some_and(|receipt| receipt.installed_digest == operation.previous_digest);
        if !receipt_state_valid || !managed_removal_valid {
            return Err("skill sync settings contain an inconsistent recovery record".to_string());
        }
    }
    Ok(())
}

fn target_skills_dir(home: &Path, id: &str) -> Result<PathBuf, String> {
    Ok(match id {
        "claude" => home.join(".claude/skills"),
        "codex" => home.join(".codex/skills"),
        "cursor" => home.join(".cursor/skills"),
        "gemini" => home.join(".gemini/skills"),
        "opencode" => home.join(".config/opencode/skills"),
        "openclaw" => home.join(".openclaw/skills"),
        "hermes" => home.join(".hermes/skills"),
        _ => return Err(format!("unsupported skill sync target: {id}")),
    })
}

fn target_detected(home: &Path, id: &str) -> bool {
    match id {
        "claude" => home.join(".claude.json").is_file() || home.join(".claude").is_dir(),
        "codex" => home.join(".codex").is_dir(),
        "cursor" => home.join(".cursor").is_dir(),
        "gemini" => home.join(".gemini").is_dir(),
        "opencode" => home.join(".config/opencode").is_dir(),
        "openclaw" => home.join(".openclaw").is_dir(),
        "hermes" => home.join(".hermes").is_dir(),
        _ => false,
    }
}

fn default_manifest_path() -> PathBuf {
    screenpipe_core::paths::default_screenpipe_data_dir().join(MANIFEST_FILE)
}

fn default_store_path() -> PathBuf {
    screenpipe_core::paths::default_screenpipe_data_dir().join("skills")
}

fn default_home() -> Result<PathBuf, String> {
    crate::skills::background_ai_tools_home()
        .ok_or_else(|| "could not resolve isolated AI tools home directory".to_string())
}

fn read_manifest(path: &Path) -> Result<SyncManifest, String> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(SyncManifest {
                schema: MANIFEST_SCHEMA,
                ..SyncManifest::default()
            });
        }
        Err(error) => return Err(format!("could not inspect skill sync settings: {error}")),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("skill sync settings are not a regular file".to_string());
    }
    let bytes = std::fs::read(path)
        .map_err(|error| format!("could not read skill sync settings: {error}"))?;
    let manifest: SyncManifest = serde_json::from_slice(&bytes)
        .map_err(|error| format!("skill sync settings are invalid: {error}"))?;
    if manifest.schema != MANIFEST_SCHEMA {
        return Err("skill sync settings use an unsupported schema".to_string());
    }
    validate_manifest(&manifest)?;
    Ok(manifest)
}

fn write_manifest(path: &Path, manifest: &SyncManifest) -> Result<(), String> {
    validate_manifest(manifest)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("could not create skill sync settings directory: {error}"))?;
    }
    let bytes = serde_json::to_vec_pretty(manifest)
        .map_err(|error| format!("could not encode skill sync settings: {error}"))?;
    crate::store::durable_write(path, &bytes)
        .map_err(|error| format!("could not save skill sync settings: {error}"))
}

fn load_store_skills(store: &Path) -> Result<Vec<StoreSkill>, String> {
    screenpipe_engine::list_local_agent_skills(store.to_path_buf()).map(|skills| {
        skills
            .into_iter()
            .filter(|skill| !crate::skills::is_managed_team_skill_dir(Path::new(&skill.path)))
            .map(|skill| StoreSkill {
                key: skill.key,
                name: skill.name,
                description: skill.description,
                origin: skill.origin,
                path: PathBuf::from(skill.path),
                enabled: skill.enabled,
            })
            .collect()
    })
}

fn load_store_skills_for_sync(store: &Path) -> Result<SyncStoreSnapshot, String> {
    let snapshot = screenpipe_engine::list_local_agent_skills_for_sync(store.to_path_buf())?;
    Ok(SyncStoreSnapshot {
        skills: snapshot
            .skills
            .into_iter()
            .filter(|skill| !crate::skills::is_managed_team_skill_dir(Path::new(&skill.path)))
            .map(|skill| StoreSkill {
                key: skill.key,
                name: skill.name,
                description: skill.description,
                origin: skill.origin,
                path: PathBuf::from(skill.path),
                enabled: skill.enabled,
            })
            .collect(),
        pending_install_keys: snapshot.pending_install_keys,
    })
}

fn collect_skill_files(root: &Path) -> Result<Vec<SkillFile>, String> {
    let metadata = std::fs::symlink_metadata(root)
        .map_err(|error| format!("could not inspect {}: {error}", root.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(format!(
            "{} is not a regular skill directory",
            root.display()
        ));
    }

    fn walk(root: &Path, current: &Path, files: &mut Vec<SkillFile>) -> Result<(), String> {
        let mut entries = std::fs::read_dir(current)
            .map_err(|error| format!("could not read {}: {error}", current.display()))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("could not read {}: {error}", current.display()))?;
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let path = entry.path();
            let relative = path
                .strip_prefix(root)
                .map_err(|_| "skill file escaped its root".to_string())?
                .to_path_buf();
            let metadata = std::fs::symlink_metadata(&path)
                .map_err(|error| format!("could not inspect {}: {error}", path.display()))?;
            if metadata.file_type().is_symlink() {
                return Err(format!(
                    "skill contains a symbolic link and cannot be synced: {}",
                    relative.display()
                ));
            }
            if metadata.is_dir() {
                walk(root, &path, files)?;
            } else if metadata.is_file() {
                if metadata.len() > MAX_SKILL_FILE_BYTES {
                    return Err(format!("skill file is too large: {}", relative.display()));
                }
                files.push(SkillFile {
                    relative,
                    source: path,
                    bytes: metadata.len(),
                });
                if files.len() > MAX_SKILL_FILES {
                    return Err(format!("skill has more than {MAX_SKILL_FILES} files"));
                }
            } else {
                return Err(format!(
                    "skill contains an unsupported file: {}",
                    relative.display()
                ));
            }
        }
        Ok(())
    }

    let mut files = Vec::new();
    walk(root, root, &mut files)?;
    let total = files.iter().map(|file| file.bytes).sum::<u64>();
    if total > MAX_SKILL_TOTAL_BYTES {
        return Err(format!("skill exceeds {MAX_SKILL_TOTAL_BYTES} bytes"));
    }
    if !files
        .iter()
        .any(|file| file.relative == Path::new("SKILL.md"))
    {
        return Err("skill has no root SKILL.md".to_string());
    }
    Ok(files)
}

fn collect_source_files(root: &Path, skill_only: bool) -> Result<Vec<SkillFile>, String> {
    if !skill_only {
        return collect_skill_files(root);
    }
    let root_metadata = std::fs::symlink_metadata(root)
        .map_err(|error| format!("could not inspect {}: {error}", root.display()))?;
    if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
        return Err(format!(
            "{} is not a regular skill directory",
            root.display()
        ));
    }
    let source = root.join("SKILL.md");
    let metadata = std::fs::symlink_metadata(&source)
        .map_err(|error| format!("could not inspect {}: {error}", source.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("skill SKILL.md is not a regular file".to_string());
    }
    if metadata.len() > MAX_SKILL_FILE_BYTES {
        return Err("skill SKILL.md is too large".to_string());
    }
    Ok(vec![SkillFile {
        relative: PathBuf::from("SKILL.md"),
        source,
        bytes: metadata.len(),
    }])
}

fn digest_files(files: &[SkillFile]) -> Result<String, String> {
    let mut digest = Sha256::new();
    for file in files {
        let relative = file.relative.to_string_lossy();
        let bytes = std::fs::read(&file.source)
            .map_err(|error| format!("could not read {}: {error}", file.source.display()))?;
        digest.update((relative.len() as u64).to_le_bytes());
        digest.update(relative.as_bytes());
        digest.update((bytes.len() as u64).to_le_bytes());
        digest.update(bytes);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn directory_digest(path: &Path) -> Result<String, String> {
    digest_files(&collect_skill_files(path)?)
}

fn projectable_source_digest(path: &Path, skill_only: bool) -> Result<String, String> {
    digest_files(&collect_source_files(path, skill_only)?)
}

fn unique_sibling(parent: &Path, key: &str, suffix: &str) -> PathBuf {
    parent.join(format!(
        ".{key}.screenpipe-{suffix}-{}-{}",
        std::process::id(),
        TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ))
}

fn ensure_regular_directory(path: &Path) -> Result<(), String> {
    std::fs::create_dir_all(path)
        .map_err(|error| format!("could not create {}: {error}", path.display()))?;
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("could not inspect {}: {error}", path.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(format!("{} is not a regular directory", path.display()));
    }
    Ok(())
}

fn entry_metadata(path: &Path) -> Result<Option<std::fs::Metadata>, String> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("could not inspect {}: {error}", path.display())),
    }
}

fn sync_regular_file(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        std::fs::File::open(path)
            .and_then(|file| file.sync_all())
            .map_err(|error| format!("could not durably sync {}: {error}", path.display()))?;
    }
    Ok(())
}

fn sync_directory(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        std::fs::File::open(path)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| {
                format!(
                    "could not durably sync directory {}: {error}",
                    path.display()
                )
            })?;
    }
    Ok(())
}

fn ensure_target_root(home: &Path, root: &Path, create: bool) -> Result<bool, String> {
    let relative = root
        .strip_prefix(home)
        .map_err(|_| "agent skill destination is outside the home directory".to_string())?;
    let mut current = home.to_path_buf();
    for component in relative.components() {
        current.push(component);
        match entry_metadata(&current)? {
            Some(metadata) if metadata.file_type().is_symlink() => {
                return Err(format!(
                    "agent skill destination contains a symbolic link: {}",
                    current.display()
                ));
            }
            Some(metadata) if !metadata.is_dir() => {
                return Err(format!(
                    "agent skill destination is not a directory: {}",
                    current.display()
                ));
            }
            Some(_) => {}
            None if create => std::fs::create_dir(&current)
                .map_err(|error| format!("could not create {}: {error}", current.display()))?,
            None => return Ok(false),
        }
    }
    Ok(true)
}

fn begin_pending_operation(
    context: &mut SyncJournalContext<'_>,
    operation: PendingSyncOperation,
) -> Result<(), SkillCopyError> {
    if context.manifest.pending_operation.is_some() {
        return Err(SkillCopyError::error(
            "another agent skill recovery is still pending",
        ));
    }
    context.manifest.pending_operation = Some(operation);
    if let Err(error) = write_manifest(context.manifest_path, context.manifest) {
        context.manifest.pending_operation = None;
        return Err(SkillCopyError::error(format!(
            "could not journal agent skill replacement: {error}"
        )));
    }
    Ok(())
}

fn abandon_resolved_operation(context: &mut Option<SyncJournalContext<'_>>) {
    if let Some(context) = context.as_mut() {
        context.manifest.pending_operation = None;
    }
}

fn previous_issue(manifest: &SyncManifest, target: &str, key: &str) -> Option<PersistedIssue> {
    manifest
        .issues
        .get(target)
        .and_then(|issues| issues.get(key))
        .cloned()
}

fn previous_receipt(manifest: &SyncManifest, target: &str, key: &str) -> Option<SyncReceipt> {
    manifest
        .receipts
        .get(target)
        .and_then(|receipts| receipts.get(key))
        .cloned()
}

fn restore_previous_issue(manifest: &mut SyncManifest, operation: &PendingSyncOperation) {
    if let Some(issue) = operation.previous_issue.clone() {
        manifest
            .issues
            .entry(operation.target.clone())
            .or_default()
            .insert(operation.skill_key.clone(), issue);
    } else {
        clear_issue(manifest, &operation.target, &operation.skill_key);
    }
}

fn restore_previous_receipt(manifest: &mut SyncManifest, operation: &PendingSyncOperation) {
    if let Some(receipt) = operation.previous_receipt.clone() {
        manifest
            .receipts
            .entry(operation.target.clone())
            .or_default()
            .insert(operation.skill_key.clone(), receipt);
    } else {
        remove_receipt(manifest, &operation.target, &operation.skill_key);
    }
}

fn commit_replacement_operation(
    context: &mut SyncJournalContext<'_>,
    source_digest: &str,
    installed_digest: &str,
) -> Result<(), SkillCopyError> {
    let previous_manifest = context.manifest.clone();
    let skill_key = context
        .manifest
        .pending_operation
        .as_ref()
        .map(|operation| operation.skill_key.clone())
        .ok_or_else(|| SkillCopyError::error("skill recovery record disappeared"))?;
    context
        .manifest
        .receipts
        .entry(context.target.to_string())
        .or_default()
        .insert(
            skill_key.clone(),
            SyncReceipt {
                source_digest: source_digest.to_string(),
                installed_digest: installed_digest.to_string(),
            },
        );
    let operation = context
        .manifest
        .pending_operation
        .as_mut()
        .ok_or_else(|| SkillCopyError::error("skill recovery record disappeared"))?;
    operation.phase = PendingSyncOperationPhase::Committed;
    clear_issue(context.manifest, context.target, &skill_key);
    if let Err(error) = write_manifest(context.manifest_path, context.manifest) {
        *context.manifest = previous_manifest;
        return Err(SkillCopyError::error(format!(
            "could not commit agent skill replacement: {error}"
        )));
    }
    Ok(())
}

fn commit_removal_operation(context: &mut SyncJournalContext<'_>) -> Result<(), SkillCopyError> {
    let previous_manifest = context.manifest.clone();
    let skill_key = context
        .manifest
        .pending_operation
        .as_ref()
        .map(|operation| operation.skill_key.clone())
        .ok_or_else(|| SkillCopyError::error("skill recovery record disappeared"))?;
    remove_receipt(context.manifest, context.target, &skill_key);
    clear_issue(context.manifest, context.target, &skill_key);
    context
        .manifest
        .pending_operation
        .as_mut()
        .ok_or_else(|| SkillCopyError::error("skill recovery record disappeared"))?
        .phase = PendingSyncOperationPhase::Committed;
    if let Err(error) = write_manifest(context.manifest_path, context.manifest) {
        *context.manifest = previous_manifest;
        return Err(SkillCopyError::error(format!(
            "could not commit agent skill removal: {error}"
        )));
    }
    Ok(())
}

struct PendingOperationPaths {
    root: PathBuf,
    destination: PathBuf,
    backup: PathBuf,
    replacement: PathBuf,
}

fn pending_operation_paths(
    home: &Path,
    operation: &PendingSyncOperation,
) -> Result<PendingOperationPaths, String> {
    let target = target_definition(&operation.target)?;
    let root = target_skills_dir(home, target.id)?;
    if !ensure_target_root(home, &root, false)? {
        return Err(format!(
            "{}'s skill directory disappeared during recovery",
            target.name
        ));
    }
    Ok(PendingOperationPaths {
        root: root.clone(),
        destination: root.join(&operation.skill_key),
        backup: root.join(&operation.backup_name),
        replacement: root.join(format!("{}.replacement", operation.backup_name)),
    })
}

fn optional_directory_digest(path: &Path) -> Result<Option<String>, String> {
    let Some(metadata) = entry_metadata(path)? else {
        return Ok(None);
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(format!("{} is not a regular directory", path.display()));
    }
    directory_digest(path).map(Some)
}

fn persist_recovery_error(
    manifest_path: &Path,
    manifest: &mut SyncManifest,
    operation: &PendingSyncOperation,
    message: impl Into<String>,
) -> Result<(), String> {
    set_issue(
        manifest,
        &operation.target,
        &operation.skill_key,
        AgentSkillSyncIssueKind::Error,
        format!(
            "Screenpipe paused an interrupted skill sync to avoid overwriting agent data: {}",
            message.into()
        ),
    );
    write_manifest(manifest_path, manifest)
}

fn finish_recovery_rollback(
    target_root: &Path,
    manifest_path: &Path,
    manifest: &mut SyncManifest,
    operation: &PendingSyncOperation,
) -> Result<(), String> {
    sync_directory(target_root)?;
    restore_previous_receipt(manifest, operation);
    restore_previous_issue(manifest, operation);
    manifest.pending_operation = None;
    write_manifest(manifest_path, manifest)
}

fn finish_committed_cleanup(
    target_root: &Path,
    manifest_path: &Path,
    manifest: &mut SyncManifest,
    operation: &PendingSyncOperation,
) -> Result<(), String> {
    sync_directory(target_root)?;
    clear_issue(manifest, &operation.target, &operation.skill_key);
    manifest.pending_operation = None;
    write_manifest(manifest_path, manifest)
}

fn finish_recovered_replacement(
    target_root: &Path,
    manifest_path: &Path,
    manifest: &mut SyncManifest,
    operation: &PendingSyncOperation,
) -> Result<(), String> {
    sync_directory(target_root)?;
    let source_digest = operation
        .source_digest
        .clone()
        .ok_or_else(|| "replacement recovery has no source digest".to_string())?;
    let installed_digest = operation
        .installed_digest
        .clone()
        .ok_or_else(|| "replacement recovery has no installed digest".to_string())?;
    manifest
        .receipts
        .entry(operation.target.clone())
        .or_default()
        .insert(
            operation.skill_key.clone(),
            SyncReceipt {
                source_digest,
                installed_digest,
            },
        );
    clear_issue(manifest, &operation.target, &operation.skill_key);
    manifest.pending_operation = None;
    write_manifest(manifest_path, manifest)
}

fn finish_recovered_removal(
    target_root: &Path,
    manifest_path: &Path,
    manifest: &mut SyncManifest,
    operation: &PendingSyncOperation,
) -> Result<(), String> {
    sync_directory(target_root)?;
    remove_receipt(manifest, &operation.target, &operation.skill_key);
    clear_issue(manifest, &operation.target, &operation.skill_key);
    manifest.pending_operation = None;
    write_manifest(manifest_path, manifest)
}

fn recover_pending_operation(
    home: &Path,
    manifest_path: &Path,
    manifest: &mut SyncManifest,
) -> Result<(), String> {
    let Some(operation) = manifest.pending_operation.clone() else {
        return Ok(());
    };
    let paths = match pending_operation_paths(home, &operation) {
        Ok(paths) => paths,
        Err(error) => {
            return persist_recovery_error(manifest_path, manifest, &operation, error);
        }
    };
    let backup_digest = match optional_directory_digest(&paths.backup) {
        Ok(digest) => digest,
        Err(error) => {
            return persist_recovery_error(manifest_path, manifest, &operation, error);
        }
    };
    let destination_digest = match optional_directory_digest(&paths.destination) {
        Ok(digest) => digest,
        Err(error) => {
            return persist_recovery_error(manifest_path, manifest, &operation, error);
        }
    };

    if operation.phase == PendingSyncOperationPhase::Committed {
        return match operation.kind {
            PendingSyncOperationKind::Replace => {
                let installed_digest = operation
                    .installed_digest
                    .as_deref()
                    .ok_or_else(|| "replacement recovery has no installed digest".to_string())?;
                let replacement_digest = match optional_directory_digest(&paths.replacement) {
                    Ok(digest) => digest,
                    Err(error) => {
                        return persist_recovery_error(manifest_path, manifest, &operation, error);
                    }
                };
                if replacement_digest.is_some() {
                    return persist_recovery_error(
                        manifest_path,
                        manifest,
                        &operation,
                        "a replacement quarantine remained after commit",
                    );
                }
                if destination_digest.as_deref() != Some(installed_digest) {
                    return persist_recovery_error(
                        manifest_path,
                        manifest,
                        &operation,
                        "the committed destination is missing or changed",
                    );
                }
                if let Some(backup_digest) = backup_digest {
                    if backup_digest != operation.previous_digest {
                        return persist_recovery_error(
                            manifest_path,
                            manifest,
                            &operation,
                            "the preserved pre-replacement copy changed during cleanup",
                        );
                    }
                    if let Err(error) = std::fs::remove_dir_all(&paths.backup) {
                        return persist_recovery_error(
                            manifest_path,
                            manifest,
                            &operation,
                            format!(
                                "the committed replacement backup could not be removed: {error}"
                            ),
                        );
                    }
                }
                finish_committed_cleanup(&paths.root, manifest_path, manifest, &operation)
            }
            PendingSyncOperationKind::ManagedRemoval
            | PendingSyncOperationKind::ExplicitRemoval => {
                if destination_digest.is_some() {
                    return persist_recovery_error(
                        manifest_path,
                        manifest,
                        &operation,
                        "a destination appeared after the removal was committed",
                    );
                }
                if let Some(backup_digest) = backup_digest {
                    if backup_digest != operation.previous_digest {
                        return persist_recovery_error(
                            manifest_path,
                            manifest,
                            &operation,
                            "the committed removal backup changed during cleanup",
                        );
                    }
                    if let Err(error) = std::fs::remove_dir_all(&paths.backup) {
                        return persist_recovery_error(
                            manifest_path,
                            manifest,
                            &operation,
                            format!("the committed removal backup could not be removed: {error}"),
                        );
                    }
                }
                finish_committed_cleanup(&paths.root, manifest_path, manifest, &operation)
            }
        };
    }

    match operation.kind {
        PendingSyncOperationKind::Replace => {
            let installed_digest = operation
                .installed_digest
                .as_deref()
                .ok_or_else(|| "replacement recovery has no installed digest".to_string())?;
            let replacement_digest = match optional_directory_digest(&paths.replacement) {
                Ok(digest) => digest,
                Err(error) => {
                    return persist_recovery_error(manifest_path, manifest, &operation, error);
                }
            };

            if let Some(replacement_digest) = replacement_digest {
                if replacement_digest != installed_digest {
                    return persist_recovery_error(
                        manifest_path,
                        manifest,
                        &operation,
                        "the quarantined replacement changed before recovery",
                    );
                }
                match (backup_digest.as_deref(), destination_digest.as_deref()) {
                    (Some(backup_digest), None) if backup_digest == operation.previous_digest => {
                        if let Err(error) = std::fs::rename(&paths.backup, &paths.destination) {
                            return persist_recovery_error(
                                manifest_path,
                                manifest,
                                &operation,
                                format!("the preserved copy could not be restored: {error}"),
                            );
                        }
                    }
                    (None, Some(digest)) if digest == operation.previous_digest => {}
                    _ => {
                        return persist_recovery_error(
                            manifest_path,
                            manifest,
                            &operation,
                            "recovery found an unexpected destination beside the preserved copy",
                        );
                    }
                }
                if let Err(error) = std::fs::remove_dir_all(&paths.replacement) {
                    return persist_recovery_error(
                        manifest_path,
                        manifest,
                        &operation,
                        format!("the proven replacement could not be discarded: {error}"),
                    );
                }
                return finish_recovery_rollback(&paths.root, manifest_path, manifest, &operation);
            }

            match (backup_digest, destination_digest) {
                (Some(backup_digest), None) if backup_digest == operation.previous_digest => {
                    if let Err(error) = std::fs::rename(&paths.backup, &paths.destination) {
                        return persist_recovery_error(
                            manifest_path,
                            manifest,
                            &operation,
                            format!("the preserved copy could not be restored: {error}"),
                        );
                    }
                    finish_recovery_rollback(&paths.root, manifest_path, manifest, &operation)
                }
                (Some(backup_digest), Some(destination_digest))
                    if backup_digest == operation.previous_digest
                        && destination_digest == installed_digest =>
                {
                    if let Err(error) = std::fs::rename(&paths.destination, &paths.replacement) {
                        return persist_recovery_error(
                            manifest_path,
                            manifest,
                            &operation,
                            format!("the replacement could not be quarantined: {error}"),
                        );
                    }
                    if let Err(error) = std::fs::rename(&paths.backup, &paths.destination) {
                        let restore_error = std::fs::rename(&paths.replacement, &paths.destination);
                        return persist_recovery_error(
                            manifest_path,
                            manifest,
                            &operation,
                            match restore_error {
                                Ok(()) => {
                                    format!("the preserved copy could not be restored: {error}")
                                }
                                Err(restore_error) => format!(
                                    "the preserved copy could not be restored ({error}), and the \
                                     replacement could not be put back ({restore_error})"
                                ),
                            },
                        );
                    }
                    if let Err(error) = std::fs::remove_dir_all(&paths.replacement) {
                        return persist_recovery_error(
                            manifest_path,
                            manifest,
                            &operation,
                            format!("the proven replacement could not be discarded: {error}"),
                        );
                    }
                    finish_recovery_rollback(&paths.root, manifest_path, manifest, &operation)
                }
                (Some(_), Some(_)) => persist_recovery_error(
                    manifest_path,
                    manifest,
                    &operation,
                    "both the preserved copy and a changed destination exist",
                ),
                (None, Some(destination_digest)) if destination_digest == installed_digest => {
                    finish_recovered_replacement(&paths.root, manifest_path, manifest, &operation)
                }
                (None, Some(destination_digest))
                    if destination_digest == operation.previous_digest =>
                {
                    finish_recovery_rollback(&paths.root, manifest_path, manifest, &operation)
                }
                (None, Some(_)) => persist_recovery_error(
                    manifest_path,
                    manifest,
                    &operation,
                    "the destination changed after the recovery record was written",
                ),
                (Some(_), None) => persist_recovery_error(
                    manifest_path,
                    manifest,
                    &operation,
                    "the preserved copy changed before it could be restored",
                ),
                (None, None) => persist_recovery_error(
                    manifest_path,
                    manifest,
                    &operation,
                    "both the destination and its preserved copy are missing",
                ),
            }
        }
        PendingSyncOperationKind::ManagedRemoval | PendingSyncOperationKind::ExplicitRemoval => {
            match (backup_digest, destination_digest) {
                (Some(backup_digest), None) if backup_digest == operation.previous_digest => {
                    if let Err(error) = std::fs::rename(&paths.backup, &paths.destination) {
                        return persist_recovery_error(
                            manifest_path,
                            manifest,
                            &operation,
                            format!("the preserved copy could not be restored: {error}"),
                        );
                    }
                    finish_recovery_rollback(&paths.root, manifest_path, manifest, &operation)
                }
                (Some(_), Some(_)) => persist_recovery_error(
                    manifest_path,
                    manifest,
                    &operation,
                    "both the preserved copy and a destination exist",
                ),
                (None, None) => {
                    finish_recovered_removal(&paths.root, manifest_path, manifest, &operation)
                }
                (None, Some(destination_digest))
                    if destination_digest == operation.previous_digest =>
                {
                    finish_recovery_rollback(&paths.root, manifest_path, manifest, &operation)
                }
                (None, Some(_)) => persist_recovery_error(
                    manifest_path,
                    manifest,
                    &operation,
                    "the destination changed after the recovery record was written",
                ),
                (Some(_), None) => persist_recovery_error(
                    manifest_path,
                    manifest,
                    &operation,
                    "the preserved copy changed before it could be restored",
                ),
            }
        }
    }
}

fn stage_skill_copy(
    source: &Path,
    staging: &Path,
    installed_name: Option<&str>,
    skill_only: bool,
) -> Result<String, String> {
    let files = collect_source_files(source, skill_only)?;
    std::fs::create_dir(staging).map_err(|error| format!("could not stage skill copy: {error}"))?;
    let result = (|| {
        for file in &files {
            let destination = staging.join(&file.relative);
            if let Some(parent) = destination.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|error| format!("could not stage skill directory: {error}"))?;
            }
            std::fs::copy(&file.source, &destination)
                .map_err(|error| format!("could not stage {}: {error}", file.relative.display()))?;
            sync_regular_file(&destination)?;
            if let Some(parent) = destination.parent() {
                sync_directory(parent)?;
            }
        }
        if let Some(installed_name) = installed_name {
            rewrite_skill_name(&staging.join("SKILL.md"), installed_name)?;
        }
        sync_directory(staging)?;
        directory_digest(staging)
    })();
    if result.is_err() {
        let _ = std::fs::remove_dir_all(staging);
    }
    result
}

fn install_staged_copy_with_rollback(
    staging: &Path,
    destination: &Path,
    backup: &Path,
) -> Result<(), SkillCopyError> {
    if let Err(install_error) = std::fs::rename(staging, destination) {
        let restore_result = std::fs::rename(backup, destination);
        let _ = std::fs::remove_dir_all(staging);
        return match restore_result {
            Ok(()) => {
                if let Some(parent) = destination.parent() {
                    if let Err(sync_error) = sync_directory(parent) {
                        return Err(SkillCopyError::unresolved(format!(
                            "could not install skill copy ({install_error}); the previous copy was \
                             restored but not durably synced ({sync_error})"
                        )));
                    }
                }
                Err(SkillCopyError::error(format!(
                    "could not install skill copy: {install_error}"
                )))
            }
            Err(restore_error) => Err(SkillCopyError::unresolved(format!(
                "could not install skill copy ({install_error}) or restore the previous copy \
                 ({restore_error}); its recovery path is {}",
                backup.display()
            ))),
        };
    }
    Ok(())
}

fn replace_skill_copy(
    source: &Path,
    destination: &Path,
    installed_name: Option<&str>,
    source_skill_only: bool,
    existing_policy: ExistingDestinationPolicy<'_>,
    journal: Option<SyncJournalContext<'_>>,
) -> Result<(String, String), SkillCopyError> {
    let parent = destination
        .parent()
        .ok_or_else(|| SkillCopyError::error("skill destination has no parent"))?;
    ensure_regular_directory(parent).map_err(SkillCopyError::error)?;
    let key = destination
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| SkillCopyError::error("skill destination has an invalid name"))?;
    let staging = unique_sibling(parent, key, "staging");
    let backup = unique_sibling(parent, key, "recovery");
    let mut journal = journal;
    let source_digest =
        projectable_source_digest(source, source_skill_only).map_err(SkillCopyError::error)?;
    let installed_digest = stage_skill_copy(source, &staging, installed_name, source_skill_only)
        .map_err(SkillCopyError::error)?;
    let verified_source_digest = match projectable_source_digest(source, source_skill_only) {
        Ok(digest) => digest,
        Err(error) => {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(SkillCopyError::error(error));
        }
    };
    if source_digest != verified_source_digest {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(SkillCopyError::error(
            "skill changed while its managed copy was being staged; retry sync",
        ));
    }
    if installed_name.is_none() && source_digest != installed_digest {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(SkillCopyError::error(
            "staged skill copy did not match its source; retry sync",
        ));
    }

    let destination_metadata = match entry_metadata(destination) {
        Ok(metadata) => metadata,
        Err(error) => {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(SkillCopyError::error(error));
        }
    };
    if let Some(metadata) = destination_metadata {
        if matches!(existing_policy, ExistingDestinationPolicy::MustBeAbsent) {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(SkillCopyError::conflict(
                "destination appeared before the skill copy could be installed",
            ));
        }
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(SkillCopyError::conflict(
                "destination is not a regular skill directory",
            ));
        }
        let previous_digest = match directory_digest(destination) {
            Ok(digest) => digest,
            Err(error) => {
                let _ = std::fs::remove_dir_all(&staging);
                return Err(SkillCopyError::conflict(error));
            }
        };
        if let ExistingDestinationPolicy::Managed(expected) = existing_policy {
            if previous_digest != expected {
                let _ = std::fs::remove_dir_all(&staging);
                return Err(SkillCopyError::conflict(
                    "the agent copy changed during sync",
                ));
            }
        }
        let Some(context) = journal.as_mut() else {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(SkillCopyError::error(
                "destructive agent skill replacement has no recovery journal",
            ));
        };
        let backup_name = backup
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| SkillCopyError::error("recovery path has an invalid name"))?
            .to_string();
        let operation = PendingSyncOperation {
            target: context.target.to_string(),
            skill_key: key.to_string(),
            kind: PendingSyncOperationKind::Replace,
            phase: PendingSyncOperationPhase::Prepared,
            backup_name,
            previous_digest: previous_digest.clone(),
            previous_receipt: previous_receipt(context.manifest, context.target, key),
            source_digest: Some(source_digest.clone()),
            installed_digest: Some(installed_digest.clone()),
            previous_issue: previous_issue(context.manifest, context.target, key),
        };
        begin_pending_operation(context, operation)?;
        if let Err(error) = std::fs::rename(destination, &backup) {
            abandon_resolved_operation(&mut journal);
            let _ = std::fs::remove_dir_all(&staging);
            return Err(SkillCopyError::error(format!(
                "could not preserve existing skill: {error}"
            )));
        }
        let preserved_digest = directory_digest(&backup);
        match preserved_digest {
            Ok(digest) if digest == previous_digest => {}
            result => {
                let restore_result = std::fs::rename(&backup, destination);
                let _ = std::fs::remove_dir_all(&staging);
                if let Err(restore_error) = restore_result {
                    return Err(SkillCopyError::unresolved(format!(
                        "the agent copy changed during sync and could not be restored \
                         ({restore_error}); its recovery path is {}",
                        backup.display()
                    )));
                }
                if let Err(sync_error) = sync_directory(parent) {
                    return Err(SkillCopyError::unresolved(sync_error));
                }
                abandon_resolved_operation(&mut journal);
                return Err(SkillCopyError::conflict(match result {
                    Ok(_) => "the agent copy changed during sync".to_string(),
                    Err(error) => error,
                }));
            }
        }
        if let Err(error) = sync_directory(parent) {
            return Err(SkillCopyError::unresolved(error));
        }
        if let Err(error) = install_staged_copy_with_rollback(&staging, destination, &backup) {
            if !error.recovery_pending {
                abandon_resolved_operation(&mut journal);
            }
            return Err(error);
        }
        if let Err(error) = sync_directory(parent) {
            return Err(SkillCopyError::unresolved(error));
        }
        let Some(context) = journal.as_mut() else {
            return Err(SkillCopyError::unresolved(
                "agent skill replacement lost its recovery journal",
            ));
        };
        if let Err(error) = commit_replacement_operation(context, &source_digest, &installed_digest)
        {
            return Err(SkillCopyError::unresolved(error.message));
        }
        if let Err(error) = std::fs::remove_dir_all(&backup) {
            return Err(SkillCopyError::unresolved(format!(
                "could not remove replaced agent skill backup ({error}); recovery will preserve \
                 the previous copy at {}",
                backup.display()
            )));
        }
        if let Err(error) = sync_directory(parent) {
            return Err(SkillCopyError::unresolved(error));
        }
        context.manifest.pending_operation = None;
    } else if let Err(error) = std::fs::rename(&staging, destination) {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(SkillCopyError::error(format!(
            "could not install skill copy: {error}"
        )));
    }
    Ok((source_digest, installed_digest))
}

fn remove_managed_skill_copy(
    destination: &Path,
    expected_digest: &str,
    journal: SyncJournalContext<'_>,
) -> Result<(), SkillCopyError> {
    remove_skill_copy_journaled(
        destination,
        Some(expected_digest),
        PendingSyncOperationKind::ManagedRemoval,
        journal,
    )
}

fn remove_skill_copy_journaled(
    destination: &Path,
    expected_digest: Option<&str>,
    kind: PendingSyncOperationKind,
    mut journal: SyncJournalContext<'_>,
) -> Result<(), SkillCopyError> {
    let parent = destination
        .parent()
        .ok_or_else(|| SkillCopyError::error("skill destination has no parent"))?;
    let key = destination
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| SkillCopyError::error("skill destination has an invalid name"))?;
    let metadata = entry_metadata(destination).map_err(SkillCopyError::error)?;
    let Some(metadata) = metadata else {
        return Ok(());
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(SkillCopyError::conflict(
            "destination is not a regular skill directory",
        ));
    }
    let previous_digest = directory_digest(destination).map_err(SkillCopyError::conflict)?;
    if expected_digest.is_some_and(|expected| previous_digest != expected) {
        return Err(SkillCopyError::conflict(
            "the agent copy changed during cleanup",
        ));
    }

    let backup = unique_sibling(parent, key, "recovery");
    let backup_name = backup
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| SkillCopyError::error("recovery path has an invalid name"))?
        .to_string();
    let operation = PendingSyncOperation {
        target: journal.target.to_string(),
        skill_key: key.to_string(),
        kind,
        phase: PendingSyncOperationPhase::Prepared,
        backup_name,
        previous_digest: previous_digest.clone(),
        previous_receipt: previous_receipt(journal.manifest, journal.target, key),
        source_digest: None,
        installed_digest: None,
        previous_issue: previous_issue(journal.manifest, journal.target, key),
    };
    begin_pending_operation(&mut journal, operation)?;
    if let Err(error) = std::fs::rename(destination, &backup) {
        journal.manifest.pending_operation = None;
        return Err(SkillCopyError::error(format!(
            "could not preserve the agent copy: {error}"
        )));
    }
    let digest_result = directory_digest(&backup);
    let matches_expected = digest_result
        .as_ref()
        .is_ok_and(|digest| digest == &previous_digest);
    if !matches_expected {
        if let Err(error) = std::fs::rename(&backup, destination) {
            return Err(SkillCopyError::unresolved(format!(
                "the managed copy changed during cleanup and could not be restored ({error}); \
                 its recovery path is {}",
                backup.display()
            )));
        }
        if let Err(sync_error) = sync_directory(parent) {
            return Err(SkillCopyError::unresolved(sync_error));
        }
        journal.manifest.pending_operation = None;
        return Err(SkillCopyError::conflict(match digest_result {
            Ok(_) => "the agent copy changed during cleanup".to_string(),
            Err(error) => error,
        }));
    }

    if let Err(error) = sync_directory(parent) {
        return Err(SkillCopyError::unresolved(error));
    }
    if let Err(error) = commit_removal_operation(&mut journal) {
        return Err(SkillCopyError::unresolved(error.message));
    }
    if let Err(error) = std::fs::remove_dir_all(&backup) {
        return Err(SkillCopyError::unresolved(format!(
            "could not remove the agent copy ({error}); recovery will preserve any remaining \
             bytes at {}",
            backup.display()
        )));
    }
    if let Err(error) = sync_directory(parent) {
        return Err(SkillCopyError::unresolved(error));
    }
    journal.manifest.pending_operation = None;
    Ok(())
}

fn remove_skill_copy_explicit(
    destination: &Path,
    journal: SyncJournalContext<'_>,
) -> Result<(), SkillCopyError> {
    remove_skill_copy_journaled(
        destination,
        None,
        PendingSyncOperationKind::ExplicitRemoval,
        journal,
    )
}

fn desired_for(skill: &StoreSkill, target: &str, manifest: &SyncManifest) -> bool {
    if !skill.enabled || !manifest.enabled_targets.contains(target) {
        return false;
    }
    if skill.origin == "agent" {
        return true;
    }
    manifest
        .shared_skills
        .get(&skill.key)
        .is_some_and(|targets| targets.contains(target))
}

fn set_issue(
    manifest: &mut SyncManifest,
    target: &str,
    key: &str,
    kind: AgentSkillSyncIssueKind,
    message: String,
) {
    manifest
        .issues
        .entry(target.to_string())
        .or_default()
        .insert(key.to_string(), PersistedIssue { kind, message });
}

fn clear_issue(manifest: &mut SyncManifest, target: &str, key: &str) {
    let remove_target = if let Some(issues) = manifest.issues.get_mut(target) {
        issues.remove(key);
        issues.is_empty()
    } else {
        false
    };
    if remove_target {
        manifest.issues.remove(target);
    }
}

fn remove_receipt(manifest: &mut SyncManifest, target: &str, key: &str) {
    let remove_target = if let Some(receipts) = manifest.receipts.get_mut(target) {
        receipts.remove(key);
        receipts.is_empty()
    } else {
        false
    };
    if remove_target {
        manifest.receipts.remove(target);
    }
}

fn reconcile_one(
    home: &Path,
    manifest_path: &Path,
    target: TargetDefinition,
    skill: Option<&StoreSkill>,
    key: &str,
    desired: bool,
    force_replace: bool,
    manifest: &mut SyncManifest,
) {
    let receipt = manifest
        .receipts
        .get(target.id)
        .and_then(|receipts| receipts.get(key))
        .cloned();
    if !desired && receipt.is_none() && !force_replace {
        clear_issue(manifest, target.id, key);
        return;
    }
    if !valid_skill_key(key) {
        set_issue(
            manifest,
            target.id,
            key,
            AgentSkillSyncIssueKind::Error,
            "skill name cannot be mapped to a safe destination".to_string(),
        );
        return;
    }
    if desired && !valid_portable_skill_key(key) {
        set_issue(
            manifest,
            target.id,
            key,
            AgentSkillSyncIssueKind::Error,
            format!(
                "{} requires a lowercase kebab-case skill name of at most 64 characters",
                target.name
            ),
        );
        return;
    }
    if desired && target.id == "opencode" {
        let Some(skill) = skill else {
            return;
        };
        let description_chars = skill.description.trim().chars().count();
        if !(1..=1024).contains(&description_chars) {
            set_issue(
                manifest,
                target.id,
                key,
                AgentSkillSyncIssueKind::Error,
                "OpenCode requires a skill description between 1 and 1024 characters".to_string(),
            );
            return;
        }
    }
    let root = match target_skills_dir(home, target.id) {
        Ok(root) => root,
        Err(error) => {
            set_issue(
                manifest,
                target.id,
                key,
                AgentSkillSyncIssueKind::Error,
                error,
            );
            return;
        }
    };
    match ensure_target_root(home, &root, desired) {
        Ok(true) => {}
        Ok(false) => {
            remove_receipt(manifest, target.id, key);
            clear_issue(manifest, target.id, key);
            return;
        }
        Err(error) => {
            set_issue(
                manifest,
                target.id,
                key,
                if receipt.is_some() {
                    AgentSkillSyncIssueKind::Conflict
                } else {
                    AgentSkillSyncIssueKind::Error
                },
                error,
            );
            return;
        }
    }
    let destination = root.join(key);

    if desired {
        let Some(skill) = skill else {
            return;
        };
        let destination_present = match entry_metadata(&destination) {
            Ok(metadata) => metadata.is_some(),
            Err(error) => {
                set_issue(
                    manifest,
                    target.id,
                    key,
                    AgentSkillSyncIssueKind::Error,
                    error,
                );
                return;
            }
        };
        if destination_present && !force_replace {
            let Some(receipt) = receipt.as_ref() else {
                set_issue(
                    manifest,
                    target.id,
                    key,
                    AgentSkillSyncIssueKind::Conflict,
                    format!(
                        "{} already has an unowned skill with this name",
                        target.name
                    ),
                );
                return;
            };
            match directory_digest(&destination) {
                Ok(digest) if digest == receipt.installed_digest => {
                    match projectable_source_digest(&skill.path, skill.origin == "agent") {
                        Ok(source_digest) if source_digest == receipt.source_digest => {
                            clear_issue(manifest, target.id, key);
                            return;
                        }
                        Ok(_) => {}
                        Err(error) => {
                            set_issue(
                                manifest,
                                target.id,
                                key,
                                AgentSkillSyncIssueKind::Error,
                                error,
                            );
                            return;
                        }
                    }
                }
                Ok(_) => {
                    set_issue(
                        manifest,
                        target.id,
                        key,
                        AgentSkillSyncIssueKind::Conflict,
                        format!(
                            "the {} copy changed after Screenpipe synced it",
                            target.name
                        ),
                    );
                    return;
                }
                Err(error) => {
                    set_issue(
                        manifest,
                        target.id,
                        key,
                        AgentSkillSyncIssueKind::Conflict,
                        error,
                    );
                    return;
                }
            }
        }

        let existing_policy = if force_replace {
            ExistingDestinationPolicy::ReplaceExplicitly
        } else if let Some(receipt) = receipt.as_ref() {
            ExistingDestinationPolicy::Managed(&receipt.installed_digest)
        } else {
            ExistingDestinationPolicy::MustBeAbsent
        };
        match replace_skill_copy(
            &skill.path,
            &destination,
            Some(key),
            skill.origin == "agent",
            existing_policy,
            Some(SyncJournalContext {
                target: target.id,
                manifest_path,
                manifest,
            }),
        ) {
            Ok((source_digest, installed_digest)) => {
                manifest
                    .receipts
                    .entry(target.id.to_string())
                    .or_default()
                    .insert(
                        key.to_string(),
                        SyncReceipt {
                            source_digest,
                            installed_digest,
                        },
                    );
                clear_issue(manifest, target.id, key);
                manifest.pending_operation = None;
            }
            Err(error) => set_issue(manifest, target.id, key, error.kind, error.message),
        }
        return;
    }

    if force_replace {
        match remove_skill_copy_explicit(
            &destination,
            SyncJournalContext {
                target: target.id,
                manifest_path,
                manifest,
            },
        ) {
            Ok(()) => {
                remove_receipt(manifest, target.id, key);
                clear_issue(manifest, target.id, key);
                manifest.pending_operation = None;
            }
            Err(error) => set_issue(manifest, target.id, key, error.kind, error.message),
        }
        return;
    }

    let Some(receipt) = receipt else {
        clear_issue(manifest, target.id, key);
        return;
    };
    match entry_metadata(&destination) {
        Ok(Some(_)) => {}
        Ok(None) => {
            remove_receipt(manifest, target.id, key);
            clear_issue(manifest, target.id, key);
            return;
        }
        Err(error) => {
            set_issue(
                manifest,
                target.id,
                key,
                AgentSkillSyncIssueKind::Error,
                error,
            );
            return;
        }
    }
    match remove_managed_skill_copy(
        &destination,
        &receipt.installed_digest,
        SyncJournalContext {
            target: target.id,
            manifest_path,
            manifest,
        },
    ) {
        Ok(()) => {
            remove_receipt(manifest, target.id, key);
            clear_issue(manifest, target.id, key);
            manifest.pending_operation = None;
        }
        Err(error) => set_issue(manifest, target.id, key, error.kind, error.message),
    }
}

fn snapshot(home: &Path, skills: &[StoreSkill], manifest: &SyncManifest) -> AgentSkillSyncSnapshot {
    let mut targets = Vec::new();
    for target in TARGETS {
        let issue_count = manifest
            .issues
            .get(target.id)
            .map_or(0, |issues| issues.len() as u64);
        let synced_count = manifest.receipts.get(target.id).map_or(0, |receipts| {
            receipts
                .keys()
                .filter(|key| {
                    !manifest
                        .issues
                        .get(target.id)
                        .is_some_and(|issues| issues.contains_key(*key))
                })
                .count() as u64
        });
        targets.push(AgentSkillSyncTarget {
            id: target.id.to_string(),
            name: target.name.to_string(),
            detected: target_detected(home, target.id),
            enabled: manifest.enabled_targets.contains(target.id),
            synced_count,
            issue_count,
        });
    }

    let mut skill_states = skills
        .iter()
        .map(|skill| {
            let automatic = skill.origin == "agent";
            let mut selected_targets = TARGETS
                .iter()
                .filter(|target| desired_for(skill, target.id, manifest))
                .map(|target| target.id.to_string())
                .collect::<Vec<_>>();
            let mut synced_targets = TARGETS
                .iter()
                .filter(|target| {
                    manifest
                        .receipts
                        .get(target.id)
                        .is_some_and(|receipts| receipts.contains_key(&skill.key))
                        && !manifest
                            .issues
                            .get(target.id)
                            .is_some_and(|issues| issues.contains_key(&skill.key))
                })
                .map(|target| target.id.to_string())
                .collect::<Vec<_>>();
            selected_targets.sort();
            synced_targets.sort();
            AgentSkillSyncSkill {
                key: skill.key.clone(),
                automatic,
                selected_targets,
                synced_targets,
            }
        })
        .collect::<Vec<_>>();
    skill_states.sort_by(|left, right| left.key.cmp(&right.key));

    let names = skills
        .iter()
        .map(|skill| (skill.key.as_str(), skill.name.as_str()))
        .collect::<BTreeMap<_, _>>();
    let mut issues = Vec::new();
    for target in TARGETS {
        if let Some(target_issues) = manifest.issues.get(target.id) {
            for (key, issue) in target_issues {
                let canonical = skills
                    .iter()
                    .find(|skill| skill.key.as_str() == key.as_str());
                let screenpipe_resolution =
                    if canonical.is_some_and(|skill| desired_for(skill, target.id, manifest)) {
                        AgentSkillSyncScreenpipeResolution::ReplaceWithScreenpipe
                    } else {
                        AgentSkillSyncScreenpipeResolution::RemoveAgentCopy
                    };
                issues.push(AgentSkillSyncIssue {
                    target: target.id.to_string(),
                    target_name: target.name.to_string(),
                    skill_key: key.clone(),
                    skill_name: names.get(key.as_str()).copied().unwrap_or(key).to_string(),
                    canonical_exists: names.contains_key(key.as_str()),
                    screenpipe_resolution,
                    kind: issue.kind.clone(),
                    message: issue.message.clone(),
                });
            }
        }
    }
    AgentSkillSyncSnapshot {
        targets,
        skills: skill_states,
        issues,
    }
}

fn reconcile_in(
    home: &Path,
    store: &Path,
    manifest_path: &Path,
    force_replace: Option<(&str, &str)>,
) -> Result<AgentSkillSyncSnapshot, String> {
    let _guard = SYNC_LOCK
        .lock()
        .map_err(|_| "skill sync state lock was poisoned".to_string())?;
    let mut manifest = read_manifest(manifest_path)?;
    recover_pending_operation(home, manifest_path, &mut manifest)?;
    if manifest.pending_operation.is_some() {
        let skills = load_store_skills(store)?;
        return Ok(snapshot(home, &skills, &manifest));
    }
    if let Some((target, key)) = force_replace {
        let issue = manifest
            .issues
            .get(target)
            .and_then(|issues| issues.get(key))
            .ok_or_else(|| "skill sync conflict no longer exists".to_string())?;
        if issue.kind != AgentSkillSyncIssueKind::Conflict {
            return Err("only a conflict can be replaced".to_string());
        }
    }
    let store_snapshot = load_store_skills_for_sync(store)?;
    let skills = store_snapshot.skills;
    let pending_install_keys = store_snapshot.pending_install_keys;
    let by_key = skills
        .iter()
        .map(|skill| (skill.key.clone(), skill))
        .collect::<BTreeMap<_, _>>();

    'targets: for target in TARGETS {
        let enabled = manifest.enabled_targets.contains(target.id);
        let detected = target_detected(home, target.id);
        // Preserve managed copies while an enabled app is temporarily absent;
        // when disabled, cleanup remains best-effort even after uninstall.
        if enabled && !detected {
            continue;
        }
        let mut keys = by_key.keys().cloned().collect::<BTreeSet<_>>();
        if let Some(receipts) = manifest.receipts.get(target.id) {
            keys.extend(receipts.keys().cloned());
        }
        if let Some(issues) = manifest.issues.get(target.id) {
            keys.extend(issues.keys().cloned());
        }
        for key in keys {
            if pending_install_keys.contains(&key) {
                continue;
            }
            let skill = by_key.get(&key).copied();
            let desired = skill.is_some_and(|skill| desired_for(skill, target.id, &manifest));
            let force = force_replace == Some((target.id, key.as_str()));
            reconcile_one(
                home,
                manifest_path,
                target,
                skill,
                &key,
                desired,
                force,
                &mut manifest,
            );
            if manifest.pending_operation.is_some() {
                break 'targets;
            }
        }
    }
    manifest.shared_skills.retain(|key, targets| {
        (by_key.contains_key(key) || pending_install_keys.contains(key)) && !targets.is_empty()
    });
    write_manifest(manifest_path, &manifest)?;
    Ok(snapshot(home, &skills, &manifest))
}

fn state_in(
    home: &Path,
    store: &Path,
    manifest_path: &Path,
) -> Result<AgentSkillSyncSnapshot, String> {
    let _guard = SYNC_LOCK
        .lock()
        .map_err(|_| "skill sync state lock was poisoned".to_string())?;
    let manifest = read_manifest(manifest_path)?;
    let skills = load_store_skills(store)?;
    Ok(snapshot(home, &skills, &manifest))
}

fn update_manifest_then_reconcile<F>(mutate: F) -> Result<AgentSkillSyncSnapshot, String>
where
    F: FnOnce(&Path, &Path, &Path, &mut SyncManifest) -> Result<(), String>,
{
    let home = default_home()?;
    let store = default_store_path();
    let manifest_path = default_manifest_path();
    {
        let _guard = SYNC_LOCK
            .lock()
            .map_err(|_| "skill sync state lock was poisoned".to_string())?;
        let mut manifest = read_manifest(&manifest_path)?;
        mutate(&home, &store, &manifest_path, &mut manifest)?;
        write_manifest(&manifest_path, &manifest)?;
    }
    reconcile_in(&home, &store, &manifest_path, None)
}

#[tauri::command]
#[specta::specta]
pub async fn get_agent_skill_sync_state() -> Result<AgentSkillSyncSnapshot, String> {
    tokio::task::spawn_blocking(|| {
        let home = default_home()?;
        state_in(&home, &default_store_path(), &default_manifest_path())
    })
    .await
    .map_err(|error| format!("skill sync worker failed: {error}"))?
}

#[tauri::command]
#[specta::specta]
pub async fn reconcile_agent_skill_sync() -> Result<AgentSkillSyncSnapshot, String> {
    tokio::task::spawn_blocking(|| {
        let home = default_home()?;
        reconcile_in(&home, &default_store_path(), &default_manifest_path(), None)
    })
    .await
    .map_err(|error| format!("skill sync worker failed: {error}"))?
}

#[tauri::command]
#[specta::specta]
pub async fn set_agent_skill_sync_target(
    target: String,
    enabled: bool,
) -> Result<AgentSkillSyncSnapshot, String> {
    tokio::task::spawn_blocking(move || {
        let definition = target_definition(&target)?;
        update_manifest_then_reconcile(|home, _, _, manifest| {
            if enabled && !target_detected(home, definition.id) {
                return Err(format!(
                    "{} was not detected on this device",
                    definition.name
                ));
            }
            if enabled {
                manifest.enabled_targets.insert(target.clone());
            } else {
                manifest.enabled_targets.remove(&target);
            }
            Ok(())
        })
    })
    .await
    .map_err(|error| format!("skill sync worker failed: {error}"))?
}

#[tauri::command]
#[specta::specta]
pub async fn set_agent_skill_sync_destination(
    skill_key: String,
    target: String,
    enabled: bool,
) -> Result<AgentSkillSyncSnapshot, String> {
    tokio::task::spawn_blocking(move || {
        target_definition(&target)?;
        update_manifest_then_reconcile(|_, store, _, manifest| {
            let skills = load_store_skills(store)?;
            let skill = skills
                .iter()
                .find(|skill| skill.key == skill_key)
                .ok_or_else(|| "skill was not found".to_string())?;
            if skill.origin == "agent" {
                return Err("generated skills use automatic target sync".to_string());
            }
            if enabled && !manifest.enabled_targets.contains(&target) {
                return Err("enable this agent before sharing individual skills".to_string());
            }
            let targets = manifest.shared_skills.entry(skill_key.clone()).or_default();
            if enabled {
                targets.insert(target.clone());
            } else {
                targets.remove(&target);
            }
            Ok(())
        })
    })
    .await
    .map_err(|error| format!("skill sync worker failed: {error}"))?
}

fn rewrite_skill_name(path: &Path, new_name: &str) -> Result<(), String> {
    let raw = std::fs::read_to_string(path)
        .map_err(|error| format!("could not read imported SKILL.md: {error}"))?;
    let newline = if raw.contains("\r\n") { "\r\n" } else { "\n" };
    let replacement = format!(
        "name: {}",
        serde_json::to_string(new_name).map_err(|error| error.to_string())?
    );
    let mut lines = raw.split_inclusive('\n');
    let first = lines
        .next()
        .ok_or_else(|| "conflicting skill has no YAML frontmatter".to_string())?;
    if first.trim() != "---" {
        return Err("conflicting skill has no YAML frontmatter".to_string());
    }
    let mut replaced = false;
    let mut closed = false;
    let mut output = String::with_capacity(raw.len() + new_name.len());
    output.push_str(first);
    for line in lines {
        if !closed && line.trim() == "---" {
            if !replaced {
                output.push_str(&replacement);
                output.push_str(newline);
                replaced = true;
            }
            closed = true;
            output.push_str(line);
        } else if !closed && !replaced && line.trim_start().starts_with("name:") {
            output.push_str(&replacement);
            if line.ends_with('\n') {
                output.push_str(newline);
            }
            replaced = true;
        } else {
            output.push_str(line);
        }
    }
    if !closed || !replaced {
        return Err("conflicting skill has invalid YAML frontmatter".to_string());
    }
    crate::store::durable_write(path, output.as_bytes())
        .map_err(|error| format!("could not rename imported skill: {error}"))
}

fn import_conflict_as_new_skill(
    home: &Path,
    store: &Path,
    target: TargetDefinition,
    skill_key: &str,
    skill_name: &str,
) -> Result<(), String> {
    let target_root = target_skills_dir(home, target.id)?;
    if !ensure_target_root(home, &target_root, false)? {
        return Err("the conflicting agent skill directory no longer exists".to_string());
    }
    let source = target_root.join(skill_key);
    if entry_metadata(&source)?.is_none() {
        return Err("the conflicting agent copy no longer exists".to_string());
    }
    ensure_regular_directory(store)?;
    let base_name = format!("{} from {}", skill_name, target.name);
    let base_key = crate::skills::skill_key(&base_name);
    let mut key = base_key.clone();
    let mut suffix = 2;
    while store.join(&key).exists() {
        key = format!("{base_key}-{suffix}");
        suffix += 1;
    }
    let destination = store.join(&key);
    replace_skill_copy(
        &source,
        &destination,
        None,
        false,
        ExistingDestinationPolicy::MustBeAbsent,
        None,
    )
    .map_err(|error| error.message)?;
    if let Err(error) = rewrite_skill_name(&destination.join("SKILL.md"), &base_name) {
        let _ = std::fs::remove_dir_all(&destination);
        return Err(error);
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn resolve_agent_skill_sync_conflict(
    skill_key: String,
    target: String,
    resolution: AgentSkillSyncConflictResolution,
) -> Result<AgentSkillSyncSnapshot, String> {
    tokio::task::spawn_blocking(move || {
        let definition = target_definition(&target)?;
        let home = default_home()?;
        let store = default_store_path();
        let manifest_path = default_manifest_path();
        match resolution {
            AgentSkillSyncConflictResolution::ReplaceWithScreenpipe => reconcile_in(
                &home,
                &store,
                &manifest_path,
                Some((definition.id, skill_key.as_str())),
            ),
            AgentSkillSyncConflictResolution::ImportAsNewSkill => {
                let restore_canonical = {
                    let _guard = SYNC_LOCK
                        .lock()
                        .map_err(|_| "skill sync state lock was poisoned".to_string())?;
                    let mut manifest = read_manifest(&manifest_path)?;
                    let issue = manifest
                        .issues
                        .get(definition.id)
                        .and_then(|issues| issues.get(&skill_key))
                        .ok_or_else(|| "skill sync conflict no longer exists".to_string())?;
                    if issue.kind != AgentSkillSyncIssueKind::Conflict {
                        return Err("only a conflict can be imported as a new skill".to_string());
                    }
                    let skills = load_store_skills(&store)?;
                    let canonical = skills.iter().find(|skill| skill.key == skill_key);
                    let canonical_name = canonical
                        .map(|skill| skill.name.as_str())
                        .unwrap_or(skill_key.as_str());
                    import_conflict_as_new_skill(
                        &home,
                        &store,
                        definition,
                        &skill_key,
                        canonical_name,
                    )?;
                    if canonical.is_none() {
                        remove_receipt(&mut manifest, &target, &skill_key);
                        clear_issue(&mut manifest, &target, &skill_key);
                    }
                    write_manifest(&manifest_path, &manifest)?;
                    canonical.is_some()
                };
                reconcile_in(
                    &home,
                    &store,
                    &manifest_path,
                    restore_canonical.then_some((definition.id, skill_key.as_str())),
                )
            }
        }
    })
    .await
    .map_err(|error| format!("skill sync worker failed: {error}"))?
}

pub fn reconcile_agent_skill_sync_in_background() {
    tauri::async_runtime::spawn(async move {
        let result = tokio::task::spawn_blocking(|| {
            let home = default_home()?;
            reconcile_in(&home, &default_store_path(), &default_manifest_path(), None)
        })
        .await;
        match result {
            Ok(Ok(snapshot)) => info!(
                enabled_targets = snapshot
                    .targets
                    .iter()
                    .filter(|target| target.enabled)
                    .count(),
                issues = snapshot.issues.len(),
                "generated skill sync reconciliation finished"
            ),
            Ok(Err(error)) => warn!(%error, "generated skill sync reconciliation failed"),
            Err(error) => warn!(%error, "generated skill sync worker failed"),
        }
    });
}

pub fn start_agent_skill_sync_watcher() {
    if WATCHER_STARTED.swap(true, Ordering::AcqRel) {
        return;
    }
    tauri::async_runtime::spawn_blocking(|| {
        let store = default_store_path();
        if let Err(error) = std::fs::create_dir_all(&store) {
            warn!(%error, "could not create the skill store for local agent sync");
            WATCHER_STARTED.store(false, Ordering::Release);
            return;
        }
        let (sender, receiver) = std::sync::mpsc::channel();
        let mut watcher =
            match notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                let _ = sender.send(event);
            }) {
                Ok(watcher) => watcher,
                Err(error) => {
                    warn!(%error, "could not start the local agent skill watcher");
                    WATCHER_STARTED.store(false, Ordering::Release);
                    return;
                }
            };
        if let Err(error) = watcher.watch(&store, RecursiveMode::Recursive) {
            warn!(%error, "could not watch the canonical skill store");
            WATCHER_STARTED.store(false, Ordering::Release);
            return;
        }

        let initial_home = match default_home() {
            Ok(home) => home,
            Err(error) => {
                warn!(%error, "could not resolve home directory for local agent skill sync");
                WATCHER_STARTED.store(false, Ordering::Release);
                return;
            }
        };
        if let Err(error) = reconcile_in(&initial_home, &store, &default_manifest_path(), None) {
            warn!(%error, "initial local agent skill reconciliation failed");
        }

        loop {
            let first = match receiver.recv() {
                Ok(event) => event,
                Err(_) => break,
            };
            let mut saw_change = match first {
                Ok(_) => true,
                Err(error) => {
                    warn!(%error, "canonical skill watcher reported an error");
                    false
                }
            };
            while let Ok(event) = receiver.recv_timeout(std::time::Duration::from_millis(300)) {
                match event {
                    Ok(_) => saw_change = true,
                    Err(error) => warn!(%error, "canonical skill watcher reported an error"),
                }
            }
            if !saw_change {
                continue;
            }
            let home = match default_home() {
                Ok(home) => home,
                Err(error) => {
                    warn!(%error, "could not resolve home directory for local agent skill sync");
                    continue;
                }
            };
            match reconcile_in(&home, &store, &default_manifest_path(), None) {
                Ok(snapshot) => info!(
                    enabled_targets = snapshot
                        .targets
                        .iter()
                        .filter(|target| target.enabled)
                        .count(),
                    issues = snapshot.issues.len(),
                    "canonical skill change reconciled to local agents"
                ),
                Err(error) => {
                    warn!(%error, "canonical skill change could not sync to local agents")
                }
            }
        }
        WATCHER_STARTED.store(false, Ordering::Release);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_skill(store: &Path, key: &str, name: &str, body: &str) {
        let dir = store.join(key);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: test skill\n---\n\n{body}\n"),
        )
        .unwrap();
    }

    fn mark_generated(store: &Path, key: &str) {
        let document = std::fs::read(store.join(key).join("SKILL.md")).unwrap();
        let sha = format!("{:x}", Sha256::digest(&document));
        std::fs::write(
            store.join(".screenpipe-agent-skills.json"),
            serde_json::to_vec_pretty(&serde_json::json!({
                "schema": 1,
                "skills": {
                    (key): {
                        "schema": 1,
                        "created_by": "screenpipe-agent",
                        "created_at": "2026-09-02T00:00:00Z",
                        "updated_at": "2026-09-02T00:00:00Z",
                        "sha256": sha
                    }
                }
            }))
            .unwrap(),
        )
        .unwrap();
    }

    fn fixture() -> (tempfile::TempDir, PathBuf, PathBuf, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let store = temp.path().join("data/skills");
        let manifest = temp.path().join("data/agent-skill-sync-v1.json");
        std::fs::create_dir_all(home.join(".codex")).unwrap();
        std::fs::create_dir_all(&store).unwrap();
        (temp, home, store, manifest)
    }

    fn prepared_replacement(
        manifest: &SyncManifest,
        target: &str,
        skill_key: &str,
        backup_name: &str,
        previous_digest: String,
    ) -> PendingSyncOperation {
        let receipt = manifest
            .receipts
            .get(target)
            .and_then(|receipts| receipts.get(skill_key))
            .cloned()
            .unwrap();
        PendingSyncOperation {
            target: target.to_string(),
            skill_key: skill_key.to_string(),
            kind: PendingSyncOperationKind::Replace,
            phase: PendingSyncOperationPhase::Prepared,
            backup_name: backup_name.to_string(),
            previous_digest,
            previous_receipt: Some(receipt.clone()),
            source_digest: Some(receipt.source_digest),
            installed_digest: Some(receipt.installed_digest),
            previous_issue: previous_issue(manifest, target, skill_key),
        }
    }

    #[test]
    fn sync_home_uses_the_ai_tool_isolation_resolver() {
        assert_eq!(
            default_home().ok(),
            crate::skills::background_ai_tools_home()
        );
    }

    #[test]
    fn generated_skills_sync_only_after_target_opt_in() {
        let (_temp, home, store, manifest_path) = fixture();
        write_skill(&store, "weekly-review", "weekly-review", "review the week");
        mark_generated(&store, "weekly-review");

        let before = reconcile_in(&home, &store, &manifest_path, None).unwrap();
        assert!(!home.join(".codex/skills/weekly-review").exists());
        assert!(
            !before
                .targets
                .iter()
                .find(|target| target.id == "codex")
                .unwrap()
                .enabled
        );

        let mut manifest = read_manifest(&manifest_path).unwrap();
        manifest.enabled_targets.insert("codex".to_string());
        write_manifest(&manifest_path, &manifest).unwrap();
        let after = reconcile_in(&home, &store, &manifest_path, None).unwrap();

        assert!(home.join(".codex/skills/weekly-review/SKILL.md").is_file());
        assert_eq!(
            after
                .targets
                .iter()
                .find(|target| target.id == "codex")
                .unwrap()
                .synced_count,
            1
        );
    }

    #[test]
    fn projected_skill_name_matches_its_folder_for_codex_and_claude() {
        let (_temp, home, store, manifest_path) = fixture();
        std::fs::create_dir_all(home.join(".claude")).unwrap();
        write_skill(&store, "weekly-review", "Weekly Review", "review the week");
        mark_generated(&store, "weekly-review");
        let mut manifest = SyncManifest::default();
        manifest.enabled_targets.insert("codex".to_string());
        manifest.enabled_targets.insert("claude".to_string());
        write_manifest(&manifest_path, &manifest).unwrap();

        let snapshot = reconcile_in(&home, &store, &manifest_path, None).unwrap();

        for installed in [
            home.join(".codex/skills/weekly-review/SKILL.md"),
            home.join(".claude/skills/weekly-review/SKILL.md"),
        ] {
            assert!(std::fs::read_to_string(installed)
                .unwrap()
                .contains("name: \"weekly-review\""));
        }
        assert!(
            std::fs::read_to_string(store.join("weekly-review/SKILL.md"))
                .unwrap()
                .contains("name: Weekly Review")
        );
        assert!(snapshot.issues.is_empty());
    }

    #[test]
    fn portable_skill_name_validation_applies_to_every_target() {
        let (_temp, home, store, manifest_path) = fixture();
        std::fs::create_dir_all(home.join(".claude")).unwrap();
        write_skill(&store, "weekly_review", "Weekly Review", "review the week");
        mark_generated(&store, "weekly_review");
        let mut manifest = SyncManifest::default();
        manifest.enabled_targets.insert("codex".to_string());
        manifest.enabled_targets.insert("claude".to_string());
        write_manifest(&manifest_path, &manifest).unwrap();

        let snapshot = reconcile_in(&home, &store, &manifest_path, None).unwrap();

        assert!(!home.join(".codex/skills/weekly_review").exists());
        assert!(!home.join(".claude/skills/weekly_review").exists());
        assert_eq!(snapshot.issues.len(), 2);
        assert!(snapshot
            .issues
            .iter()
            .all(|issue| issue.message.contains("lowercase kebab-case")));
    }

    #[test]
    fn imported_skills_require_an_explicit_destination() {
        let (_temp, home, store, manifest_path) = fixture();
        write_skill(&store, "personal", "personal", "personal workflow");
        std::fs::create_dir_all(store.join("personal/references")).unwrap();
        std::fs::write(
            store.join("personal/references/checklist.md"),
            "# Checklist\n",
        )
        .unwrap();
        let mut manifest = SyncManifest {
            schema: 1,
            ..SyncManifest::default()
        };
        manifest.enabled_targets.insert("codex".to_string());
        write_manifest(&manifest_path, &manifest).unwrap();
        reconcile_in(&home, &store, &manifest_path, None).unwrap();
        assert!(!home.join(".codex/skills/personal").exists());

        let mut manifest = read_manifest(&manifest_path).unwrap();
        manifest
            .shared_skills
            .entry("personal".to_string())
            .or_default()
            .insert("codex".to_string());
        write_manifest(&manifest_path, &manifest).unwrap();
        reconcile_in(&home, &store, &manifest_path, None).unwrap();
        assert!(home.join(".codex/skills/personal/SKILL.md").is_file());
        assert!(home
            .join(".codex/skills/personal/references/checklist.md")
            .is_file());
    }

    #[test]
    fn unowned_destination_is_preserved_until_explicit_replace() {
        let (_temp, home, store, manifest_path) = fixture();
        write_skill(
            &store,
            "weekly-review",
            "weekly-review",
            "canonical workflow",
        );
        mark_generated(&store, "weekly-review");
        write_skill(
            &home.join(".codex/skills"),
            "weekly-review",
            "weekly-review",
            "existing codex workflow",
        );
        let mut manifest = SyncManifest {
            schema: 1,
            ..SyncManifest::default()
        };
        manifest.enabled_targets.insert("codex".to_string());
        write_manifest(&manifest_path, &manifest).unwrap();

        assert!(reconcile_in(
            &home,
            &store,
            &manifest_path,
            Some(("codex", "weekly-review"))
        )
        .is_err());
        let conflicted = reconcile_in(&home, &store, &manifest_path, None).unwrap();
        assert_eq!(conflicted.issues.len(), 1);
        assert!(
            std::fs::read_to_string(home.join(".codex/skills/weekly-review/SKILL.md"))
                .unwrap()
                .contains("existing codex workflow")
        );

        let resolved = reconcile_in(
            &home,
            &store,
            &manifest_path,
            Some(("codex", "weekly-review")),
        )
        .unwrap();
        assert!(resolved.issues.is_empty());
        assert!(
            std::fs::read_to_string(home.join(".codex/skills/weekly-review/SKILL.md"))
                .unwrap()
                .contains("canonical workflow")
        );
    }

    #[test]
    fn must_be_absent_copy_policy_never_replaces_a_late_destination() {
        let (_temp, home, store, _manifest_path) = fixture();
        write_skill(
            &store,
            "weekly-review",
            "weekly-review",
            "canonical workflow",
        );
        let destination = home.join(".codex/skills/weekly-review");
        write_skill(
            &home.join(".codex/skills"),
            "weekly-review",
            "weekly-review",
            "concurrent canonical workflow",
        );

        let error = replace_skill_copy(
            &store.join("weekly-review"),
            &destination,
            Some("weekly-review"),
            false,
            ExistingDestinationPolicy::MustBeAbsent,
            None,
        )
        .unwrap_err();

        assert_eq!(error.kind, AgentSkillSyncIssueKind::Conflict);
        assert!(std::fs::read_to_string(destination.join("SKILL.md"))
            .unwrap()
            .contains("concurrent canonical workflow"));
    }

    #[test]
    fn interrupted_replacement_restores_a_complete_backup_before_reconciling() {
        let (_temp, home, store, manifest_path) = fixture();
        write_skill(
            &store,
            "weekly-review",
            "weekly-review",
            "canonical workflow",
        );
        mark_generated(&store, "weekly-review");
        let mut manifest = SyncManifest::default();
        manifest.enabled_targets.insert("codex".to_string());
        write_manifest(&manifest_path, &manifest).unwrap();
        reconcile_in(&home, &store, &manifest_path, None).unwrap();

        let root = home.join(".codex/skills");
        let destination = root.join("weekly-review");
        let original = std::fs::read(destination.join("SKILL.md")).unwrap();
        let previous_digest = directory_digest(&destination).unwrap();
        let backup_name = ".weekly-review.screenpipe-recovery-999-1";
        let backup = root.join(backup_name);
        let mut manifest = read_manifest(&manifest_path).unwrap();
        manifest.pending_operation = Some(prepared_replacement(
            &manifest,
            "codex",
            "weekly-review",
            backup_name,
            previous_digest,
        ));
        write_manifest(&manifest_path, &manifest).unwrap();
        std::fs::rename(&destination, &backup).unwrap();

        let snapshot = reconcile_in(&home, &store, &manifest_path, None).unwrap();

        assert!(snapshot.issues.is_empty());
        assert_eq!(
            std::fs::read(destination.join("SKILL.md")).unwrap(),
            original
        );
        assert!(!backup.exists());
        assert!(read_manifest(&manifest_path)
            .unwrap()
            .pending_operation
            .is_none());
    }

    #[test]
    fn ambiguous_replacement_preserves_both_copies_and_blocks_reconciliation() {
        let (_temp, home, store, manifest_path) = fixture();
        write_skill(
            &store,
            "weekly-review",
            "weekly-review",
            "canonical workflow",
        );
        mark_generated(&store, "weekly-review");
        let mut manifest = SyncManifest::default();
        manifest.enabled_targets.insert("codex".to_string());
        write_manifest(&manifest_path, &manifest).unwrap();
        reconcile_in(&home, &store, &manifest_path, None).unwrap();

        let root = home.join(".codex/skills");
        let destination = root.join("weekly-review");
        let previous_digest = directory_digest(&destination).unwrap();
        let backup_name = ".weekly-review.screenpipe-recovery-999-2";
        let backup = root.join(backup_name);
        let mut manifest = read_manifest(&manifest_path).unwrap();
        let receipt_before = manifest.receipts["codex"]["weekly-review"].clone();
        manifest.pending_operation = Some(prepared_replacement(
            &manifest,
            "codex",
            "weekly-review",
            backup_name,
            previous_digest,
        ));
        write_manifest(&manifest_path, &manifest).unwrap();
        std::fs::rename(&destination, &backup).unwrap();
        write_skill(
            &root,
            "weekly-review",
            "weekly-review",
            "concurrent agent edit",
        );
        let backup_before = std::fs::read(backup.join("SKILL.md")).unwrap();
        let destination_before = std::fs::read(destination.join("SKILL.md")).unwrap();

        let snapshot = reconcile_in(&home, &store, &manifest_path, None).unwrap();

        assert_eq!(snapshot.issues.len(), 1);
        assert_eq!(snapshot.issues[0].kind, AgentSkillSyncIssueKind::Error);
        assert!(snapshot.issues[0]
            .message
            .contains("avoid overwriting agent data"));
        assert_eq!(
            std::fs::read(backup.join("SKILL.md")).unwrap(),
            backup_before
        );
        assert_eq!(
            std::fs::read(destination.join("SKILL.md")).unwrap(),
            destination_before
        );
        let recovered = read_manifest(&manifest_path).unwrap();
        assert!(recovered.pending_operation.is_some());
        assert_eq!(recovered.receipts["codex"]["weekly-review"], receipt_before);
    }

    #[test]
    fn committed_replacement_never_restores_a_partial_backup() {
        let (_temp, home, store, manifest_path) = fixture();
        write_skill(
            &store,
            "weekly-review",
            "weekly-review",
            "canonical workflow",
        );
        mark_generated(&store, "weekly-review");
        let mut manifest = SyncManifest::default();
        manifest.enabled_targets.insert("codex".to_string());
        write_manifest(&manifest_path, &manifest).unwrap();
        reconcile_in(&home, &store, &manifest_path, None).unwrap();

        let root = home.join(".codex/skills");
        let destination = root.join("weekly-review");
        let previous_digest = directory_digest(&destination).unwrap();
        let backup_name = ".weekly-review.screenpipe-recovery-999-3";
        let backup = root.join(backup_name);
        std::fs::rename(&destination, &backup).unwrap();
        write_skill(
            &root,
            "weekly-review",
            "weekly-review",
            "committed replacement",
        );
        let installed_digest = directory_digest(&destination).unwrap();
        std::fs::write(backup.join("SKILL.md"), "partial old copy\n").unwrap();
        let partial_backup = std::fs::read(backup.join("SKILL.md")).unwrap();
        let committed_copy = std::fs::read(destination.join("SKILL.md")).unwrap();

        let mut manifest = read_manifest(&manifest_path).unwrap();
        let previous_receipt = manifest.receipts["codex"]["weekly-review"].clone();
        let source_digest = "a".repeat(64);
        manifest.receipts.get_mut("codex").unwrap().insert(
            "weekly-review".to_string(),
            SyncReceipt {
                source_digest: source_digest.clone(),
                installed_digest: installed_digest.clone(),
            },
        );
        manifest.pending_operation = Some(PendingSyncOperation {
            target: "codex".to_string(),
            skill_key: "weekly-review".to_string(),
            kind: PendingSyncOperationKind::Replace,
            phase: PendingSyncOperationPhase::Committed,
            backup_name: backup_name.to_string(),
            previous_digest,
            previous_receipt: Some(previous_receipt),
            source_digest: Some(source_digest),
            installed_digest: Some(installed_digest),
            previous_issue: None,
        });
        write_manifest(&manifest_path, &manifest).unwrap();

        let snapshot = reconcile_in(&home, &store, &manifest_path, None).unwrap();

        assert_eq!(snapshot.issues.len(), 1);
        assert!(snapshot.issues[0]
            .message
            .contains("changed during cleanup"));
        assert_eq!(
            std::fs::read(backup.join("SKILL.md")).unwrap(),
            partial_backup
        );
        assert_eq!(
            std::fs::read(destination.join("SKILL.md")).unwrap(),
            committed_copy
        );
        assert!(read_manifest(&manifest_path)
            .unwrap()
            .pending_operation
            .is_some());
    }

    #[test]
    fn interrupted_managed_removal_restores_its_complete_backup() {
        let (_temp, home, store, manifest_path) = fixture();
        write_skill(
            &store,
            "weekly-review",
            "weekly-review",
            "canonical workflow",
        );
        mark_generated(&store, "weekly-review");
        let mut manifest = SyncManifest::default();
        manifest.enabled_targets.insert("codex".to_string());
        write_manifest(&manifest_path, &manifest).unwrap();
        reconcile_in(&home, &store, &manifest_path, None).unwrap();

        let root = home.join(".codex/skills");
        let destination = root.join("weekly-review");
        let original = std::fs::read(destination.join("SKILL.md")).unwrap();
        let previous_digest = directory_digest(&destination).unwrap();
        let backup_name = ".weekly-review.screenpipe-recovery-999-4";
        let backup = root.join(backup_name);
        let mut manifest = read_manifest(&manifest_path).unwrap();
        let previous_receipt = manifest.receipts["codex"]["weekly-review"].clone();
        manifest.pending_operation = Some(PendingSyncOperation {
            target: "codex".to_string(),
            skill_key: "weekly-review".to_string(),
            kind: PendingSyncOperationKind::ManagedRemoval,
            phase: PendingSyncOperationPhase::Prepared,
            backup_name: backup_name.to_string(),
            previous_digest,
            previous_receipt: Some(previous_receipt.clone()),
            source_digest: None,
            installed_digest: None,
            previous_issue: None,
        });
        write_manifest(&manifest_path, &manifest).unwrap();
        std::fs::rename(&destination, &backup).unwrap();

        recover_pending_operation(&home, &manifest_path, &mut manifest).unwrap();

        assert_eq!(
            std::fs::read(destination.join("SKILL.md")).unwrap(),
            original
        );
        assert!(!backup.exists());
        let recovered = read_manifest(&manifest_path).unwrap();
        assert!(recovered.pending_operation.is_none());
        assert_eq!(
            recovered.receipts["codex"]["weekly-review"],
            previous_receipt
        );
    }

    #[test]
    fn committed_explicit_removal_finishes_without_restoring_the_backup() {
        let (_temp, home, store, manifest_path) = fixture();
        write_skill(
            &store,
            "weekly-review",
            "weekly-review",
            "canonical workflow",
        );
        mark_generated(&store, "weekly-review");
        let mut manifest = SyncManifest::default();
        manifest.enabled_targets.insert("codex".to_string());
        write_manifest(&manifest_path, &manifest).unwrap();
        reconcile_in(&home, &store, &manifest_path, None).unwrap();

        let root = home.join(".codex/skills");
        let destination = root.join("weekly-review");
        let previous_digest = directory_digest(&destination).unwrap();
        let backup_name = ".weekly-review.screenpipe-recovery-999-5";
        let backup = root.join(backup_name);
        std::fs::rename(&destination, &backup).unwrap();
        let mut manifest = read_manifest(&manifest_path).unwrap();
        let previous_receipt = manifest.receipts["codex"]["weekly-review"].clone();
        remove_receipt(&mut manifest, "codex", "weekly-review");
        manifest.pending_operation = Some(PendingSyncOperation {
            target: "codex".to_string(),
            skill_key: "weekly-review".to_string(),
            kind: PendingSyncOperationKind::ExplicitRemoval,
            phase: PendingSyncOperationPhase::Committed,
            backup_name: backup_name.to_string(),
            previous_digest,
            previous_receipt: Some(previous_receipt),
            source_digest: None,
            installed_digest: None,
            previous_issue: None,
        });
        write_manifest(&manifest_path, &manifest).unwrap();

        recover_pending_operation(&home, &manifest_path, &mut manifest).unwrap();

        assert!(!destination.exists());
        assert!(!backup.exists());
        let recovered = read_manifest(&manifest_path).unwrap();
        assert!(recovered.pending_operation.is_none());
        assert!(!recovered
            .receipts
            .get("codex")
            .is_some_and(|receipts| receipts.contains_key("weekly-review")));
    }

    #[test]
    fn failed_install_reports_the_preserved_copy_when_restore_also_fails() {
        let temp = tempfile::tempdir().unwrap();
        let staging = temp.path().join("staging");
        let destination = temp.path().join("destination");
        let backup = temp.path().join("backup");
        for directory in [&staging, &destination, &backup] {
            std::fs::create_dir(directory).unwrap();
        }
        std::fs::write(staging.join("SKILL.md"), "staged\n").unwrap();
        std::fs::write(destination.join("SKILL.md"), "concurrent\n").unwrap();
        std::fs::write(backup.join("SKILL.md"), "preserved\n").unwrap();

        let error = install_staged_copy_with_rollback(&staging, &destination, &backup).unwrap_err();

        assert!(error.message.contains(&backup.display().to_string()));
        assert_eq!(
            std::fs::read_to_string(backup.join("SKILL.md")).unwrap(),
            "preserved\n"
        );
        assert_eq!(
            std::fs::read_to_string(destination.join("SKILL.md")).unwrap(),
            "concurrent\n"
        );
        assert!(!staging.exists());
    }

    #[test]
    fn one_target_error_does_not_block_other_targets() {
        let (_temp, home, store, manifest_path) = fixture();
        std::fs::create_dir_all(home.join(".config/opencode")).unwrap();
        std::fs::write(home.join(".config/opencode/skills"), "blocked by a file\n").unwrap();
        write_skill(&store, "daily-review", "daily-review", "review the day");
        mark_generated(&store, "daily-review");
        let mut manifest = SyncManifest {
            schema: 1,
            ..SyncManifest::default()
        };
        manifest.enabled_targets.insert("codex".to_string());
        manifest.enabled_targets.insert("opencode".to_string());
        write_manifest(&manifest_path, &manifest).unwrap();

        let snapshot = reconcile_in(&home, &store, &manifest_path, None).unwrap();

        assert!(home.join(".codex/skills/daily-review/SKILL.md").is_file());
        assert!(home.join(".config/opencode/skills").is_file());
        assert_eq!(snapshot.issues.len(), 1);
        assert_eq!(snapshot.issues[0].target, "opencode");
        assert_eq!(snapshot.issues[0].kind, AgentSkillSyncIssueKind::Error);
    }

    #[test]
    fn generated_projection_copies_only_the_proven_skill_document() {
        let (_temp, home, store, manifest_path) = fixture();
        write_skill(&store, "weekly-review", "weekly-review", "review the week");
        std::fs::write(
            store.join("weekly-review/unproven-script.sh"),
            "echo user-added\n",
        )
        .unwrap();
        mark_generated(&store, "weekly-review");
        let mut manifest = SyncManifest::default();
        manifest.enabled_targets.insert("codex".to_string());
        write_manifest(&manifest_path, &manifest).unwrap();

        reconcile_in(&home, &store, &manifest_path, None).unwrap();

        assert!(home.join(".codex/skills/weekly-review/SKILL.md").is_file());
        assert!(!home
            .join(".codex/skills/weekly-review/unproven-script.sh")
            .exists());
    }

    #[test]
    fn opencode_copy_uses_its_folder_key_as_frontmatter_name() {
        let (_temp, home, store, manifest_path) = fixture();
        std::fs::create_dir_all(home.join(".config/opencode")).unwrap();
        write_skill(&store, "weekly-review", "Weekly Review", "review the week");
        mark_generated(&store, "weekly-review");
        let mut manifest = SyncManifest::default();
        manifest.enabled_targets.insert("opencode".to_string());
        write_manifest(&manifest_path, &manifest).unwrap();

        let snapshot = reconcile_in(&home, &store, &manifest_path, None).unwrap();

        let installed =
            std::fs::read_to_string(home.join(".config/opencode/skills/weekly-review/SKILL.md"))
                .unwrap();
        assert!(installed.contains("name: \"weekly-review\""));
        assert!(
            std::fs::read_to_string(store.join("weekly-review/SKILL.md"))
                .unwrap()
                .contains("name: Weekly Review")
        );
        assert!(snapshot.issues.is_empty());
    }

    #[test]
    fn unshared_import_does_not_create_an_opencode_name_error() {
        let (_temp, home, store, manifest_path) = fixture();
        std::fs::create_dir_all(home.join(".config/opencode")).unwrap();
        write_skill(&store, "daily_review", "daily_review", "review the day");
        let mut manifest = SyncManifest::default();
        manifest.enabled_targets.insert("opencode".to_string());
        write_manifest(&manifest_path, &manifest).unwrap();

        let snapshot = reconcile_in(&home, &store, &manifest_path, None).unwrap();

        assert!(snapshot.issues.is_empty());
        assert!(!home.join(".config/opencode/skills/daily_review").exists());
    }

    #[test]
    fn changed_destination_becomes_a_conflict_and_is_preserved() {
        let (_temp, home, store, manifest_path) = fixture();
        write_skill(&store, "weekly-review", "weekly-review", "review the week");
        mark_generated(&store, "weekly-review");
        let mut manifest = SyncManifest {
            schema: 1,
            ..SyncManifest::default()
        };
        manifest.enabled_targets.insert("codex".to_string());
        write_manifest(&manifest_path, &manifest).unwrap();
        reconcile_in(&home, &store, &manifest_path, None).unwrap();

        let destination = home.join(".codex/skills/weekly-review/SKILL.md");
        std::fs::write(&destination, "edited in codex\n").unwrap();
        write_skill(
            &store,
            "weekly-review",
            "weekly-review",
            "new canonical workflow",
        );
        mark_generated(&store, "weekly-review");
        let snapshot = reconcile_in(&home, &store, &manifest_path, None).unwrap();

        assert_eq!(
            std::fs::read_to_string(destination).unwrap(),
            "edited in codex\n"
        );
        assert_eq!(snapshot.issues.len(), 1);
        assert_eq!(snapshot.issues[0].kind, AgentSkillSyncIssueKind::Conflict);
        assert_eq!(
            snapshot.issues[0].screenpipe_resolution,
            AgentSkillSyncScreenpipeResolution::ReplaceWithScreenpipe
        );
    }

    #[test]
    fn conflict_reports_remove_action_after_its_destination_is_disabled() {
        let (_temp, home, store, manifest_path) = fixture();
        write_skill(
            &store,
            "weekly-review",
            "weekly-review",
            "canonical workflow",
        );
        mark_generated(&store, "weekly-review");
        let mut manifest = SyncManifest::default();
        manifest.enabled_targets.insert("codex".to_string());
        write_manifest(&manifest_path, &manifest).unwrap();
        reconcile_in(&home, &store, &manifest_path, None).unwrap();
        let destination = home.join(".codex/skills/weekly-review/SKILL.md");
        std::fs::write(&destination, "edited in codex\n").unwrap();
        assert_eq!(
            reconcile_in(&home, &store, &manifest_path, None)
                .unwrap()
                .issues[0]
                .screenpipe_resolution,
            AgentSkillSyncScreenpipeResolution::ReplaceWithScreenpipe
        );

        let mut manifest = read_manifest(&manifest_path).unwrap();
        manifest.enabled_targets.remove("codex");
        write_manifest(&manifest_path, &manifest).unwrap();
        let disabled = reconcile_in(&home, &store, &manifest_path, None).unwrap();

        assert!(disabled.issues[0].canonical_exists);
        assert_eq!(
            disabled.issues[0].screenpipe_resolution,
            AgentSkillSyncScreenpipeResolution::RemoveAgentCopy
        );
        let resolved = reconcile_in(
            &home,
            &store,
            &manifest_path,
            Some(("codex", "weekly-review")),
        )
        .unwrap();
        assert!(resolved.issues.is_empty());
        assert!(!home.join(".codex/skills/weekly-review").exists());
    }

    #[test]
    fn stale_unowned_collision_clears_after_canonical_skill_is_removed() {
        let (_temp, home, store, manifest_path) = fixture();
        write_skill(
            &store,
            "weekly-review",
            "weekly-review",
            "canonical workflow",
        );
        mark_generated(&store, "weekly-review");
        write_skill(
            &home.join(".codex/skills"),
            "weekly-review",
            "weekly-review",
            "existing codex workflow",
        );
        let mut manifest = SyncManifest::default();
        manifest.enabled_targets.insert("codex".to_string());
        write_manifest(&manifest_path, &manifest).unwrap();
        assert_eq!(
            reconcile_in(&home, &store, &manifest_path, None)
                .unwrap()
                .issues
                .len(),
            1
        );

        std::fs::remove_dir_all(store.join("weekly-review")).unwrap();
        let snapshot = reconcile_in(&home, &store, &manifest_path, None).unwrap();

        assert!(snapshot.issues.is_empty());
        assert!(home.join(".codex/skills/weekly-review/SKILL.md").is_file());
    }

    #[test]
    fn explicit_resolution_can_remove_a_changed_copy_after_canonical_deletion() {
        let (_temp, home, store, manifest_path) = fixture();
        write_skill(
            &store,
            "weekly-review",
            "weekly-review",
            "canonical workflow",
        );
        mark_generated(&store, "weekly-review");
        let mut manifest = SyncManifest::default();
        manifest.enabled_targets.insert("codex".to_string());
        write_manifest(&manifest_path, &manifest).unwrap();
        reconcile_in(&home, &store, &manifest_path, None).unwrap();

        let destination = home.join(".codex/skills/weekly-review/SKILL.md");
        std::fs::write(&destination, "edited in codex\n").unwrap();
        std::fs::remove_dir_all(store.join("weekly-review")).unwrap();
        let conflicted = reconcile_in(&home, &store, &manifest_path, None).unwrap();
        assert_eq!(conflicted.issues.len(), 1);
        assert!(!conflicted.issues[0].canonical_exists);

        let resolved = reconcile_in(
            &home,
            &store,
            &manifest_path,
            Some(("codex", "weekly-review")),
        )
        .unwrap();
        assert!(resolved.issues.is_empty());
        assert!(!home.join(".codex/skills/weekly-review").exists());
    }

    #[test]
    fn pending_canonical_install_preserves_the_last_managed_copy() {
        let (_temp, home, store, manifest_path) = fixture();
        write_skill(
            &store,
            "weekly-review",
            "weekly-review",
            "committed workflow",
        );
        mark_generated(&store, "weekly-review");
        let previous_document =
            std::fs::read_to_string(store.join("weekly-review/SKILL.md")).unwrap();
        let previous_sha = format!("{:x}", Sha256::digest(previous_document.as_bytes()));
        let mut manifest = SyncManifest::default();
        manifest.enabled_targets.insert("codex".to_string());
        write_manifest(&manifest_path, &manifest).unwrap();
        reconcile_in(&home, &store, &manifest_path, None).unwrap();

        write_skill(&store, "weekly-review", "weekly-review", "pending workflow");
        mark_generated(&store, "weekly-review");
        let pending_document =
            std::fs::read_to_string(store.join("weekly-review/SKILL.md")).unwrap();
        let pending_sha = format!("{:x}", Sha256::digest(pending_document.as_bytes()));
        let recovery_path = store.join(".screenpipe-agent-skill-installs.json");
        std::fs::write(
            &recovery_path,
            serde_json::to_vec_pretty(&serde_json::json!({
                "schema": 1,
                "installs": {
                    "weekly-review": {
                        "schema": 1,
                        "key": "weekly-review",
                        "source": "activity-opportunity:skill-1",
                        "installed_sha256": pending_sha,
                        "previous_document": previous_document,
                        "previous_marker": {
                            "schema": 1,
                            "created_by": "screenpipe-agent",
                            "created_at": "2026-09-02T00:00:00Z",
                            "updated_at": "2026-09-02T00:00:00Z",
                            "sha256": previous_sha
                        }
                    }
                }
            }))
            .unwrap(),
        )
        .unwrap();

        reconcile_in(&home, &store, &manifest_path, None).unwrap();
        let destination = home.join(".codex/skills/weekly-review/SKILL.md");
        assert!(std::fs::read_to_string(&destination)
            .unwrap()
            .contains("committed workflow"));

        std::fs::remove_file(recovery_path).unwrap();
        reconcile_in(&home, &store, &manifest_path, None).unwrap();
        assert!(std::fs::read_to_string(destination)
            .unwrap()
            .contains("pending workflow"));
    }

    #[test]
    fn disabling_target_removes_only_an_unchanged_managed_copy() {
        let (_temp, home, store, manifest_path) = fixture();
        write_skill(&store, "weekly-review", "weekly-review", "review the week");
        mark_generated(&store, "weekly-review");
        let mut manifest = SyncManifest {
            schema: 1,
            ..SyncManifest::default()
        };
        manifest.enabled_targets.insert("codex".to_string());
        write_manifest(&manifest_path, &manifest).unwrap();
        reconcile_in(&home, &store, &manifest_path, None).unwrap();

        let mut manifest = read_manifest(&manifest_path).unwrap();
        manifest.enabled_targets.remove("codex");
        write_manifest(&manifest_path, &manifest).unwrap();
        reconcile_in(&home, &store, &manifest_path, None).unwrap();

        assert!(!home.join(".codex/skills/weekly-review").exists());
    }

    #[test]
    fn disabling_generated_skill_removes_its_unchanged_managed_copy() {
        let (_temp, home, store, manifest_path) = fixture();
        write_skill(&store, "weekly-review", "weekly-review", "review the week");
        mark_generated(&store, "weekly-review");
        let mut manifest = SyncManifest {
            schema: 1,
            ..SyncManifest::default()
        };
        manifest.enabled_targets.insert("codex".to_string());
        write_manifest(&manifest_path, &manifest).unwrap();
        reconcile_in(&home, &store, &manifest_path, None).unwrap();

        std::fs::write(
            store.join("weekly-review/.screenpipe-disabled"),
            b"disabled by user\n",
        )
        .unwrap();
        reconcile_in(&home, &store, &manifest_path, None).unwrap();

        assert!(!home.join(".codex/skills/weekly-review").exists());
    }

    #[test]
    fn invalid_receipt_key_is_rejected_before_any_projection() {
        let (_temp, home, store, manifest_path) = fixture();
        write_skill(&store, "weekly-review", "weekly-review", "review the week");
        mark_generated(&store, "weekly-review");
        std::fs::create_dir_all(manifest_path.parent().unwrap()).unwrap();
        std::fs::write(
            &manifest_path,
            serde_json::to_vec_pretty(&serde_json::json!({
                "schema": 1,
                "enabled_targets": ["codex"],
                "receipts": {
                    "codex": {
                        "../outside": {
                            "source_digest": "0".repeat(64),
                            "installed_digest": "0".repeat(64)
                        }
                    }
                }
            }))
            .unwrap(),
        )
        .unwrap();

        assert!(reconcile_in(&home, &store, &manifest_path, None).is_err());
        assert!(!home.join(".codex/skills/weekly-review").exists());
    }

    #[test]
    fn recovery_record_cannot_choose_an_arbitrary_backup_path() {
        let (_temp, home, store, manifest_path) = fixture();
        write_skill(&store, "weekly-review", "weekly-review", "review the week");
        mark_generated(&store, "weekly-review");
        std::fs::create_dir_all(manifest_path.parent().unwrap()).unwrap();
        std::fs::write(
            &manifest_path,
            serde_json::to_vec_pretty(&serde_json::json!({
                "schema": 1,
                "enabled_targets": ["codex"],
                "pending_operation": {
                    "target": "codex",
                    "skill_key": "weekly-review",
                    "kind": "replace",
                    "phase": "prepared",
                    "backup_name": "../../outside",
                    "previous_digest": "0".repeat(64),
                    "source_digest": "1".repeat(64),
                    "installed_digest": "2".repeat(64)
                }
            }))
            .unwrap(),
        )
        .unwrap();

        assert!(reconcile_in(&home, &store, &manifest_path, None).is_err());
        assert!(!home.join(".codex/skills/weekly-review").exists());
    }

    #[test]
    fn conflicting_agent_copy_can_be_imported_under_a_new_canonical_key() {
        let (_temp, home, store, _manifest_path) = fixture();
        write_skill(
            &home.join(".codex/skills"),
            "weekly-review",
            "weekly-review",
            "edited in codex",
        );

        import_conflict_as_new_skill(
            &home,
            &store,
            target_definition("codex").unwrap(),
            "weekly-review",
            "Weekly Review",
        )
        .unwrap();

        let imported =
            std::fs::read_to_string(store.join("weekly-review-from-codex/SKILL.md")).unwrap();
        assert!(imported.contains("name: \"Weekly Review from Codex\""));
        assert!(imported.contains("edited in codex"));
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_target_root_is_rejected() {
        use std::os::unix::fs::symlink;

        let (_temp, home, store, manifest_path) = fixture();
        write_skill(&store, "weekly-review", "weekly-review", "review the week");
        mark_generated(&store, "weekly-review");
        std::fs::remove_dir(home.join(".codex")).unwrap();
        let outside = home.parent().unwrap().join("redirected-codex");
        std::fs::create_dir_all(&outside).unwrap();
        symlink(&outside, home.join(".codex")).unwrap();
        let mut manifest = SyncManifest {
            schema: 1,
            ..SyncManifest::default()
        };
        manifest.enabled_targets.insert("codex".to_string());
        write_manifest(&manifest_path, &manifest).unwrap();

        let snapshot = reconcile_in(&home, &store, &manifest_path, None).unwrap();

        assert_eq!(snapshot.issues.len(), 1);
        assert!(snapshot.issues[0].message.contains("symbolic link"));
        assert!(!outside.join("skills/weekly-review").exists());
    }

    #[cfg(unix)]
    #[test]
    fn conflict_import_does_not_follow_a_symlinked_target_root() {
        use std::os::unix::fs::symlink;

        let (_temp, home, store, _manifest_path) = fixture();
        std::fs::remove_dir(home.join(".codex")).unwrap();
        let outside = home.parent().unwrap().join("redirected-codex-import");
        write_skill(
            &outside.join("skills"),
            "weekly-review",
            "weekly-review",
            "outside workflow",
        );
        symlink(&outside, home.join(".codex")).unwrap();

        let error = import_conflict_as_new_skill(
            &home,
            &store,
            target_definition("codex").unwrap(),
            "weekly-review",
            "Weekly Review",
        )
        .unwrap_err();

        assert!(error.contains("symbolic link"));
        assert!(!store.join("weekly-review-from-codex").exists());
    }
}
