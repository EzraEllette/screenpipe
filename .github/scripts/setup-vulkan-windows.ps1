# screenpipe — AI that knows everything you've seen, said, or heard
# https://screenpipe.com

[CmdletBinding()]
param(
    [ValidateSet('x64', 'arm64')]
    [string]$Architecture = 'x64',
    [switch]$InstallSdk,
    [string]$StageRuntimeDirectory
)

$ErrorActionPreference = 'Stop'
$version = '1.4.357.0'
$isArm64 = $Architecture -eq 'arm64'

if ($InstallSdk) {
    $sdk = "C:\VulkanSDK\$version"
    if (Test-Path -LiteralPath "$sdk\Include\vulkan\vulkan.h") {
        "VULKAN_SDK=$sdk" | Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8
        "$sdk\Bin" | Out-File -FilePath $env:GITHUB_PATH -Append -Encoding utf8
    } else {
    $sdkUri = if ($isArm64) {
        "https://sdk.lunarg.com/sdk/download/$version/warm/vulkan_sdk.exe"
    } else {
        "https://sdk.lunarg.com/sdk/download/$version/windows/vulkan_sdk.exe"
    }
    $sdkSha = if ($isArm64) {
        'c10f18a9085018f66e1f50bd60623f17b7081faca165248de54f78728120f334'
    } else {
        '81f474711e9042f4cd22b31b2f7a8870db2e428b21586fb43dd80150be97310d'
    }
    if (-not (Test-Path -LiteralPath vulkan_sdk.exe)) {
        Invoke-WebRequest -Uri $sdkUri -OutFile vulkan_sdk.exe
    }
    if ((Get-FileHash vulkan_sdk.exe -Algorithm SHA256).Hash.ToLowerInvariant() -ne $sdkSha) {
        throw 'Vulkan SDK installer hash mismatch'
    }
    & .\vulkan_sdk.exe --accept-licenses --default-answer --confirm-command install copy_only=1
    if ($LASTEXITCODE -ne 0) { throw "Vulkan SDK install failed: $LASTEXITCODE" }
    if (-not (Test-Path -LiteralPath "$sdk\Include\vulkan\vulkan.h")) {
        throw "Vulkan SDK headers missing at $sdk"
    }
    "VULKAN_SDK=$sdk" | Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8
    "$sdk\Bin" | Out-File -FilePath $env:GITHUB_PATH -Append -Encoding utf8
    }
}

if ($StageRuntimeDirectory) {
    $runtimeUri = if ($isArm64) {
        "https://sdk.lunarg.com/sdk/download/$version/warm/VulkanRT-ARM64-$version-Components.zip"
    } else {
        "https://sdk.lunarg.com/sdk/download/$version/windows/VulkanRT-X64-$version-Components.zip"
    }
    $runtimeSha = if ($isArm64) {
        '0a51a619525e0c7a156125c4f80c4f591c494cef9ff59dc4481735779a9a280c'
    } else {
        'a14672efed15aafc7f5a16572d35cd3a3416eadf670aeee3cdf50ee32d5fbf83'
    }
    $component = if ($isArm64) { "VulkanRT-ARM64-$version-Components" } else { "VulkanRT-X64-$version-Components" }
    $loader = if ($isArm64) { "$component/vulkan-1.dll" } else { "$component/x64/vulkan-1.dll" }
    if (-not (Test-Path -LiteralPath vulkan-runtime.zip)) {
        Invoke-WebRequest -Uri $runtimeUri -OutFile vulkan-runtime.zip
    }
    if ((Get-FileHash vulkan-runtime.zip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $runtimeSha) {
        throw 'Vulkan runtime archive hash mismatch'
    }
    if (Test-Path -LiteralPath vulkan-runtime) { Remove-Item -LiteralPath vulkan-runtime -Recurse -Force }
    7z x vulkan-runtime.zip -ovulkan-runtime -y
    if ($LASTEXITCODE -ne 0) { throw "Vulkan runtime extraction failed: $LASTEXITCODE" }
    New-Item -ItemType Directory -Force -Path $StageRuntimeDirectory | Out-Null
    Copy-Item -LiteralPath "vulkan-runtime/$loader" -Destination "$StageRuntimeDirectory/vulkan-1.dll"
    Copy-Item -LiteralPath "vulkan-runtime/$component/VulkanRT-License.txt" -Destination "$StageRuntimeDirectory/VulkanRT-License.txt"
}
