// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Adapter that lets the Pipe runtime execute in an existing screenpipe chat.

use super::{AgentExecutor, AgentOutput, ExecutionHandle, SharedPid};
use anyhow::{anyhow, Result};
use serde_json::Value;
use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::sync::Arc;

pub const CHAT_DESTINATION_EXECUTOR: &str = "screenpipe-chat";

#[derive(Clone)]
pub struct ChatDestinationRequest {
    pub chat_id: String,
    pub message: String,
    pub display_preview: String,
    pub shared_pid: Option<SharedPid>,
}

pub type ChatDestinationDispatch = Arc<
    dyn Fn(
            ChatDestinationRequest,
        ) -> Pin<Box<dyn Future<Output = std::result::Result<(), String>> + Send>>
        + Send
        + Sync,
>;

pub struct ChatDestinationExecutor {
    dispatch: ChatDestinationDispatch,
}

impl ChatDestinationExecutor {
    pub fn new(dispatch: ChatDestinationDispatch) -> Self {
        Self { dispatch }
    }

    fn chat_id(config: Option<&Value>) -> Result<String> {
        let chat_id = config
            .and_then(|value| value.get("chat_id"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| anyhow!("existing chat destination is missing its chat id"))?;
        if chat_id.len() > 200 {
            return Err(anyhow!("existing chat destination has an invalid chat id"));
        }
        Ok(chat_id.to_string())
    }

    fn execution_message(
        prompt: &str,
        pipe_system_prompt: Option<&str>,
        working_dir: &Path,
    ) -> String {
        let output_dir = working_dir.join("output");
        let directory_note = format!(
            "Scheduled task directory: {}\nResolve relative task paths against this directory and write declared outputs under {}.",
            working_dir.display(),
            output_dir.display(),
        );
        match pipe_system_prompt
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            Some(instructions) => {
                let instructions = instructions.replace(
                    "Output directory: ./output/",
                    &format!("Output directory: {}/", output_dir.display()),
                );
                format!("{directory_note}\n\n{instructions}\n\n{prompt}")
            }
            None => format!("{directory_note}\n\n{prompt}"),
        }
    }
}

#[async_trait::async_trait]
impl AgentExecutor for ChatDestinationExecutor {
    async fn run(
        &self,
        _prompt: &str,
        _model: &str,
        _working_dir: &Path,
        _provider: Option<&str>,
        _provider_url: Option<&str>,
        _provider_api_key: Option<&str>,
        _shared_pid: Option<SharedPid>,
        _continue_session: bool,
    ) -> Result<AgentOutput> {
        Err(anyhow!(
            "existing chat destinations require the streaming Pipe runtime"
        ))
    }

    async fn run_streaming(
        &self,
        prompt: &str,
        _model: &str,
        working_dir: &Path,
        _provider: Option<&str>,
        _provider_url: Option<&str>,
        _provider_api_key: Option<&str>,
        shared_pid: Option<SharedPid>,
        _line_tx: tokio::sync::mpsc::UnboundedSender<String>,
        _continue_session: bool,
        _thinking_level: Option<&str>,
        pipe_system_prompt: Option<&str>,
        _mcp_server_allowlist: Option<&[String]>,
        _session_owner: Option<&str>,
        executor_config: Option<&Value>,
    ) -> Result<AgentOutput> {
        let chat_id = Self::chat_id(executor_config)?;
        let pipe_name = working_dir
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("scheduled task");
        (self.dispatch)(ChatDestinationRequest {
            chat_id,
            message: Self::execution_message(prompt, pipe_system_prompt, working_dir),
            display_preview: format!("Scheduled task: {pipe_name}"),
            shared_pid,
        })
        .await
        .map_err(anyhow::Error::msg)?;

        Ok(AgentOutput {
            stdout: String::new(),
            stderr: String::new(),
            success: true,
            pid: None,
        })
    }

    fn kill(&self, _handle: &ExecutionHandle) -> Result<()> {
        // The dispatch future owns an async cancellation guard. Pipe stop and
        // timeout drop that future, which removes a queued prompt or aborts the
        // active turn in the exact target chat.
        Ok(())
    }

    fn is_available(&self) -> bool {
        true
    }

    async fn ensure_installed(&self) -> Result<()> {
        Ok(())
    }

    fn name(&self) -> &str {
        CHAT_DESTINATION_EXECUTOR
    }
}

#[cfg(test)]
mod tests {
    use super::ChatDestinationExecutor;
    use serde_json::json;

    #[test]
    fn exact_chat_id_is_required() {
        assert!(ChatDestinationExecutor::chat_id(None).is_err());
        assert!(ChatDestinationExecutor::chat_id(Some(&json!({ "chat_id": "  " }))).is_err());
        assert_eq!(
            ChatDestinationExecutor::chat_id(Some(&json!({ "chat_id": " chat-42 " }))).unwrap(),
            "chat-42"
        );
    }

    #[test]
    fn execution_message_includes_pipe_instructions_and_run_context() {
        let message = ChatDestinationExecutor::execution_message(
            "Run date: 2026-09-02",
            Some("Summarize the customer's open issues."),
            std::path::Path::new("/tmp/daily-recap"),
        );
        assert!(message.contains("Summarize the customer's open issues."));
        assert!(message.contains("Run date: 2026-09-02"));
        assert!(message.contains("/tmp/daily-recap/output"));
    }
}
