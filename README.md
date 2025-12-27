# MyHackMD - Simple Local Markdown Editor

A minimal HackMD clone built with Vanilla HTML/CSS/JS and Node.js/Express.

## Features

- 📝 Split-screen Markdown editor (Editor + Live Preview)
- 💾 Auto-save functionality (saves after 1 second of inactivity)
- 📁 File tree sidebar for browsing markdown files
- 🎨 Clean, minimal UI inspired by VS Code
- 📦 No database - files stored locally in `bin/` folder

## Getting Started

### 1. Install Dependencies

```bash
npm install
```

### 2. Start the Server

```bash
npm start
```

The server will start on `http://localhost:3000`

### 3. Open in Browser

Navigate to `http://localhost:3000` in your web browser.

## Project Structure

```
MyHackMD/
├── bin/                 # Stores all .md files (simulate database)
├── public/
│   ├── index.html       # Main UI
│   ├── style.css        # Styling
│   └── script.js        # Frontend logic
├── server.js            # Express server with API endpoints
└── package.json
```

## API Endpoints

- `GET /api/files` - Get file tree structure from `bin/` folder
- `GET /api/file?path=...` - Read content of a specific .md file
- `POST /api/save` - Save file content (body: `{ path, content }`)

## Usage

1. **Browse Files**: Click on any file in the sidebar to open it
2. **Edit**: Type in the left editor panel
3. **Preview**: See live preview on the right panel
4. **Create New File**: Click the **+** button in the sidebar
5. **Auto-Save**: Changes are automatically saved after 1 second of inactivity

## Tech Stack

- **Frontend**: Vanilla JavaScript (ES6+), HTML5, CSS3
- **Backend**: Node.js with Express
- **Markdown**: markdown-it (via CDN)