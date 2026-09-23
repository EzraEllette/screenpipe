// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

use audiopipe::ParakeetExecutionProvider;

const MIN_DEDICATED_VIDEO_MEMORY: u64 = 4 * 1024 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
struct AdapterCandidate {
    name: String,
    dedicated_video_memory: u64,
    software: bool,
    remote: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ParakeetProviderChoice {
    pub provider: ParakeetExecutionProvider,
    pub reason: String,
}

fn choose_from_candidates(
    override_value: Option<&str>,
    candidates: impl IntoIterator<Item = AdapterCandidate>,
) -> ParakeetProviderChoice {
    if override_value.is_some_and(|value| value == "0" || value.eq_ignore_ascii_case("false")) {
        return ParakeetProviderChoice {
            provider: ParakeetExecutionProvider::Cpu,
            reason: "SCREENPIPE_DIRECTML explicitly disabled".to_string(),
        };
    }

    let eligible = candidates
        .into_iter()
        .filter(|adapter| !adapter.software && !adapter.remote)
        .filter(|adapter| adapter.dedicated_video_memory >= MIN_DEDICATED_VIDEO_MEMORY)
        .max_by_key(|adapter| adapter.dedicated_video_memory);

    match eligible {
        Some(adapter) => ParakeetProviderChoice {
            provider: ParakeetExecutionProvider::DirectMl,
            reason: format!(
                "eligible high-performance adapter '{}' with {} MiB dedicated video memory",
                adapter.name,
                adapter.dedicated_video_memory / (1024 * 1024)
            ),
        },
        None => ParakeetProviderChoice {
            provider: ParakeetExecutionProvider::Cpu,
            reason:
                "no non-software, non-remote adapter with at least 4096 MiB dedicated video memory"
                    .to_string(),
        },
    }
}

pub(crate) fn choose_parakeet_provider() -> ParakeetProviderChoice {
    choose_from_candidates(
        std::env::var("SCREENPIPE_DIRECTML").ok().as_deref(),
        enumerate_adapters().unwrap_or_default(),
    )
}

fn enumerate_adapters() -> windows::core::Result<Vec<AdapterCandidate>> {
    use windows::Win32::Graphics::Dxgi::{
        CreateDXGIFactory1, IDXGIFactory1, DXGI_ADAPTER_FLAG_REMOTE, DXGI_ADAPTER_FLAG_SOFTWARE,
        DXGI_ERROR_NOT_FOUND,
    };

    let factory: IDXGIFactory1 = unsafe { CreateDXGIFactory1()? };
    let mut adapters = Vec::new();
    for index in 0.. {
        let adapter = match unsafe { factory.EnumAdapters1(index) } {
            Ok(adapter) => adapter,
            Err(error) if error.code() == DXGI_ERROR_NOT_FOUND => break,
            Err(error) => return Err(error),
        };
        let desc = unsafe { adapter.GetDesc1()? };
        let name_len = desc
            .Description
            .iter()
            .position(|character| *character == 0)
            .unwrap_or(desc.Description.len());
        adapters.push(AdapterCandidate {
            name: String::from_utf16_lossy(&desc.Description[..name_len]),
            dedicated_video_memory: desc.DedicatedVideoMemory as u64,
            software: desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 != 0,
            remote: desc.Flags & DXGI_ADAPTER_FLAG_REMOTE.0 as u32 != 0,
        });
    }
    Ok(adapters)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn adapter(name: &str, gib: u64) -> AdapterCandidate {
        AdapterCandidate {
            name: name.to_string(),
            dedicated_video_memory: gib * 1024 * 1024 * 1024,
            software: false,
            remote: false,
        }
    }

    #[test]
    fn automatically_selects_largest_eligible_hardware_adapter() {
        let choice = choose_from_candidates(None, [adapter("GPU 4", 4), adapter("GPU 8", 8)]);
        assert_eq!(choice.provider, ParakeetExecutionProvider::DirectMl);
        assert!(choice.reason.contains("GPU 8"));
    }

    #[test]
    fn explicit_cpu_override_wins() {
        let choice = choose_from_candidates(Some("false"), [adapter("GPU", 8)]);
        assert_eq!(choice.provider, ParakeetExecutionProvider::Cpu);
        assert!(choice.reason.contains("explicitly disabled"));
    }

    #[test]
    fn rejects_integrated_low_memory_software_and_remote_adapters() {
        let mut software = adapter("software", 16);
        software.software = true;
        let mut remote = adapter("remote", 16);
        remote.remote = true;
        let choice = choose_from_candidates(
            None,
            [
                adapter("integrated", 0),
                adapter("low", 2),
                software,
                remote,
            ],
        );
        assert_eq!(choice.provider, ParakeetExecutionProvider::Cpu);
        assert!(choice.reason.contains("no non-software"));
    }

    #[test]
    fn actual_adapter_selection_is_fresh_and_deterministic() {
        let first = choose_parakeet_provider();
        let second = choose_parakeet_provider();
        println!("actual Windows Parakeet provider choice: {first:?}");
        assert_eq!(first, second);
    }
}
