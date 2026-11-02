# Configures the Windows DPAPI credential without putting the key in arguments or plaintext files.
param(
    [Parameter(Mandatory = $true)][string]$BaseUrl,
    [Parameter(Mandatory = $true)][string]$Model,
    [string]$ProModel,
    [string]$DefaultReasoningEffort,
    [string]$ContextWindowTokens,
    [string]$MaxOutputTokens,
    [string]$StateDir,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$safeMessages = @(
    'This setup requires Windows.',
    'The API base URL must be HTTPS without userinfo, query, or fragment.',
    'The model must be a valid DeepSeek model ID.',
    'Invalid default reasoning effort.',
    'Invalid capability limits.',
    'The state directory must be a regular directory.',
    'Configuration or credential already exists; use -Force to replace it.',
    'The API key must contain 1 to 8192 printable ASCII characters.'
)

try {
    if (-not [System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform(
        [System.Runtime.InteropServices.OSPlatform]::Windows)) {
        throw 'This setup requires Windows.'
    }

    $parsed = $null
    if (-not [System.Uri]::TryCreate($BaseUrl, [System.UriKind]::Absolute, [ref]$parsed) -or
        $parsed.Scheme -ne 'https' -or $parsed.UserInfo -or $parsed.Query -or $parsed.Fragment -or
        $BaseUrl -match '[?#]' -or $BaseUrl -ne $BaseUrl.Trim()) {
        throw 'The API base URL must be HTTPS without userinfo, query, or fragment.'
    }
    if ($Model -cnotmatch '(?i)^deepseek[A-Za-z0-9._:-]{1,120}$' -or
        ($ProModel -and $ProModel -cnotmatch '(?i)^deepseek[A-Za-z0-9._:-]{1,120}$')) {
        throw 'The model must be a valid DeepSeek model ID.'
    }
    if ($PSBoundParameters.ContainsKey('DefaultReasoningEffort') -and
        @('none', 'low', 'high', 'max') -cnotcontains $DefaultReasoningEffort) {
        throw 'Invalid default reasoning effort.'
    }
    $context = $null
    if ($PSBoundParameters.ContainsKey('ContextWindowTokens')) {
        $parsedContext = [long]0
        if ($ContextWindowTokens -cnotmatch '^\d+$' -or
            -not [long]::TryParse($ContextWindowTokens, [ref]$parsedContext) -or
            $parsedContext -lt 32 -or $parsedContext -gt 1048576) {
            throw 'Invalid capability limits.'
        }
        $context = [int]$parsedContext
    }
    $output = $null
    if ($PSBoundParameters.ContainsKey('MaxOutputTokens')) {
        $parsedOutput = [long]0
        if ($MaxOutputTokens -cnotmatch '^\d+$' -or
            -not [long]::TryParse($MaxOutputTokens, [ref]$parsedOutput) -or
            $parsedOutput -lt 32 -or $parsedOutput -gt 393216) {
            throw 'Invalid capability limits.'
        }
        $output = [int]$parsedOutput
    }
    if ($null -ne $context -and $null -ne $output -and $output -gt $context) {
        throw 'Invalid capability limits.'
    }

    $hostPart = if ($parsed.HostNameType -eq [System.UriHostNameType]::IPv6) {
        "[$($parsed.IdnHost)]"
    } else {
        $parsed.IdnHost
    }
    $origin = "https://$hostPart"
    if (-not $parsed.IsDefaultPort) { $origin += ":$($parsed.Port)" }
    $path = $parsed.AbsolutePath.TrimEnd('/')
    $normalizedBase = "$origin$path"
    $models = [ordered]@{ flash = $Model }
    if ($ProModel) { $models.pro = $ProModel }
    $profile = [ordered]@{}
    if ($null -ne $context) { $profile.context_window_tokens = $context }
    if ($null -ne $output) { $profile.max_output_tokens = $output }
    $connection = [ordered]@{
        base_url = $normalizedBase
        allowed_origin = $origin
        protocol = 'openai'
        model = $Model
        models = $models
        credential_source = 'dpapi'
    }
    if ($PSBoundParameters.ContainsKey('DefaultReasoningEffort')) {
        $connection['default_reasoning_effort'] = $DefaultReasoningEffort
    }
    if ($profile.Count -gt 0) {
        $capabilities = [ordered]@{ flash = $profile }
        if ($ProModel) { $capabilities.pro = $profile }
        $connection['capabilities'] = $capabilities
    }

    if (-not $StateDir) {
        $stateRoot = if ($env:CODEX_HOME) { $env:CODEX_HOME } else {
            [System.IO.Path]::Combine([Environment]::GetFolderPath('UserProfile'), '.codex')
        }
        $StateDir = [System.IO.Path]::Combine($stateRoot, 'deepseek-collaboration')
    }
    $resolvedState = [System.IO.Path]::GetFullPath($StateDir)
    [System.IO.Directory]::CreateDirectory($resolvedState) | Out-Null
    $stateItem = Get-Item -LiteralPath $resolvedState -Force
    if (-not $stateItem.PSIsContainer -or
        ($stateItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw 'The state directory must be a regular directory.'
    }

    $configPath = [System.IO.Path]::Combine($resolvedState, 'connection.json')
    $credentialPath = [System.IO.Path]::Combine($resolvedState, 'credential.dpapi')
    if (-not $Force -and ((Test-Path -LiteralPath $configPath) -or
        (Test-Path -LiteralPath $credentialPath))) {
        throw 'Configuration or credential already exists; use -Force to replace it.'
    }

    $secureKey = Read-Host -Prompt 'DeepSeek API key' -AsSecureString
    try {
        if ($null -eq $secureKey -or $secureKey.Length -lt 1 -or $secureKey.Length -gt 8192) {
            throw 'The API key must contain 1 to 8192 printable ASCII characters.'
        }
        $keyPointer = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
        try {
            for ($index = 0; $index -lt $secureKey.Length; $index++) {
                $character = [System.Runtime.InteropServices.Marshal]::ReadInt16($keyPointer, $index * 2)
                if ($character -lt 33 -or $character -gt 126) {
                    throw 'The API key must contain 1 to 8192 printable ASCII characters.'
                }
            }
        } finally {
            [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer)
        }
        $protectedKey = ConvertFrom-SecureString -SecureString $secureKey
    } finally {
        if ($null -ne $secureKey) { $secureKey.Dispose() }
    }

    $utf8 = [System.Text.UTF8Encoding]::new($false)
    $configTemp = [System.IO.Path]::Combine($resolvedState, ".connection.$([guid]::NewGuid()).tmp")
    $credentialTemp = [System.IO.Path]::Combine($resolvedState, ".credential.$([guid]::NewGuid()).tmp")
    try {
        [System.IO.File]::WriteAllText($configTemp, (($connection | ConvertTo-Json -Depth 5) + "`n"), $utf8)
        [System.IO.File]::WriteAllText($credentialTemp, ($protectedKey + "`n"), $utf8)
        [System.IO.File]::Move($credentialTemp, $credentialPath, [bool]$Force)
        [System.IO.File]::Move($configTemp, $configPath, [bool]$Force)
    } finally {
        if (Test-Path -LiteralPath $configTemp) { Remove-Item -LiteralPath $configTemp -Force }
        if (Test-Path -LiteralPath $credentialTemp) { Remove-Item -LiteralPath $credentialTemp -Force }
    }
    [Console]::Out.WriteLine('Connection and protected credential configured.')
} catch {
    $message = if ($safeMessages -ccontains $_.Exception.Message) {
        $_.Exception.Message
    } else {
        'Configuration could not be written.'
    }
    [Console]::Error.WriteLine($message)
    exit 1
}
