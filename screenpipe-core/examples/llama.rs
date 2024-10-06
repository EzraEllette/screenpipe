use anyhow::Result;

#[cfg(feature = "llm")]
fn main() -> Result<()> {
    use screenpipe_core::LLM;

    let llm = LLM::new(screenpipe_core::ModelName::Llama)?;

    let res = llm.chat(screenpipe_core::ChatRequest {
        messages: vec![screenpipe_core::ChatMessage {
            role: "user".to_string(),
            content: "What is the meaning of life?".to_string(),
        }],
        temperature: None,
        top_k: None,
        top_p: None,
        max_completion_tokens: None,
        seed: None,
        stream: false,
    })?;

    println!("{:?}", res.choices[0].message.content);

    println!("{:?}", res.usage.tps);
    Ok(())
}
