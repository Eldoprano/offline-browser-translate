# Fixing "Ollama is blocking the extension" (CORS)

Ollama only accepts requests from origins in its `OLLAMA_ORIGINS` allowlist,
which is empty by default. This is common on any fresh install and isn't
specific to this extension - set `OLLAMA_ORIGINS=*` to allow all origins
(fine for a local-only machine), then restart Ollama.

**Linux (systemd)**
```bash
sudo systemctl edit ollama.service
```
Add under `[Service]`:
```
Environment="OLLAMA_ORIGINS=*"
```
```bash
sudo systemctl daemon-reload && sudo systemctl restart ollama
```

**macOS (desktop app)**
```bash
launchctl setenv OLLAMA_ORIGINS "*"
```
Then quit and reopen Ollama from the menu bar.

**Running `ollama serve` directly (macOS/Linux)**
```bash
OLLAMA_ORIGINS="*" ollama serve
```

**Windows**
Quit Ollama from the system tray, add an `OLLAMA_ORIGINS` environment
variable set to `*` (Settings → Advanced system settings → Environment
Variables), then restart Ollama. Or in PowerShell: `$env:OLLAMA_ORIGINS="*"; ollama serve`

**Docker**
```bash
docker run -d -e OLLAMA_ORIGINS="*" -v ollama:/root/.ollama -p 11434:11434 --name ollama ollama/ollama
```

Prefer something narrower than `*`? Use:
```
OLLAMA_ORIGINS=chrome-extension://*,moz-extension://*,safari-web-extension://*
```

After changing it, click the refresh button in the extension popup - the
banner clears once Ollama restarts with the new setting.
