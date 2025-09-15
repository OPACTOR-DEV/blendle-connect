# Blendle Connect

Connect to ChatGPT (Codex) and Gemini CLI tools with OAuth authentication.

## Features

- ✅ OAuth-only authentication (no API keys)
- ✅ Automatic CLI tool installation
- ✅ TypeScript with modular architecture
- ✅ File-based logging system
- ✅ Cross-platform support (macOS, Windows, Linux)

## Architecture

```
src/
├── main/           # Main process
│   ├── index.ts
│   ├── types/
│   ├── config/
│   ├── utils/
│   └── services/
├── renderer/       # Renderer process
│   ├── index.html
│   ├── styles.css
│   └── renderer.ts
└── preload/        # Preload scripts
    └── preload.ts
```

## Development

```bash
# Install dependencies
npm install

# Run in development mode (with debug logging)
npm run dev

# Build TypeScript
npm run build:ts

# Build application
npm run build

# Build for macOS (unsigned)
npm run build:mac-unsigned
```

## Logging

Logs are stored in:
- macOS: `~/Library/Application Support/blendle-connect/logs/`
- Windows: `%APPDATA%/blendle-connect/logs/`
- Linux: `~/.config/blendle-connect/logs/`

## Environment Variables

- `NODE_ENV=development` - Enable development mode with debug logging
- `BLENDLE_DEBUG=1` - Enable verbose debug output

## License

MIT