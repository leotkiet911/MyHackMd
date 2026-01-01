const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const http = require('http');
const { Server } = require('socket.io');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = 3000;

// Handle paths for both development and pkg (executable)
// When running as .exe, __dirname points to a temp folder, so we use process.execPath
const isPkg = typeof process.pkg !== 'undefined';
let baseDir = isPkg ? path.dirname(process.execPath) : __dirname;

// If .exe is in public folder, use parent directory as baseDir (root directory)
// Normalize paths for cross-platform compatibility
const normalizedBaseDir = path.normalize(baseDir);
const baseDirName = path.basename(normalizedBaseDir).toLowerCase();
if (isPkg && baseDirName === 'public') {
  baseDir = path.dirname(normalizedBaseDir);
}

const BIN_FOLDER = path.join(baseDir, 'bin');
let PUBLIC_FOLDER = isPkg ? path.join(baseDir, 'public') : path.join(__dirname, 'public');

// If running as .exe and public folder doesn't exist, extract from bundled assets
if (isPkg && !fs.existsSync(PUBLIC_FOLDER)) {
  // Try to access bundled public folder from pkg
  // pkg extracts assets to a temp folder accessible via __dirname
  const bundledPublic = path.join(__dirname, 'public');
  if (fs.existsSync(bundledPublic)) {
    // Copy public folder from bundled location to baseDir
    PUBLIC_FOLDER = path.join(baseDir, 'public');
    if (!fs.existsSync(PUBLIC_FOLDER)) {
      fs.mkdirSync(PUBLIC_FOLDER, { recursive: true });
      copyDirSync(bundledPublic, PUBLIC_FOLDER);
    }
  }
}

// Helper function to check if a path is within a base directory (cross-platform safe)
function isPathWithinBase(filePath, basePath) {
  const normalizedFilePath = path.resolve(filePath).toLowerCase();
  const normalizedBasePath = path.resolve(basePath).toLowerCase();
  return normalizedFilePath.startsWith(normalizedBasePath);
}

// Helper function to copy directory
function copyDirSync(src, dest) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// Middleware
app.use(bodyParser.json({ limit: '50mb' }));
app.use(express.static(PUBLIC_FOLDER));

// Ensure bin folder exists
if (!fs.existsSync(BIN_FOLDER)) {
  fs.mkdirSync(BIN_FOLDER, { recursive: true });
  console.log(`📁 Created bin folder at: ${BIN_FOLDER}`);
}

// Log paths for debugging
console.log('📂 Paths configuration:');
console.log(`   Base directory: ${baseDir}`);
console.log(`   Bin folder: ${BIN_FOLDER}`);
console.log(`   Public folder: ${PUBLIC_FOLDER}`);
console.log(`   Bin folder exists: ${fs.existsSync(BIN_FOLDER)}`);

// Helper function to recursively scan directory and return file tree
function scanDirectory(dir, basePath = '') {
  const items = [];
  
  // Check if directory exists
  if (!fs.existsSync(dir)) {
    console.warn(`⚠️  Directory does not exist: ${dir}`);
    return items;
  }
  
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.join(basePath, entry.name).replace(/\\/g, '/');

      try {
        if (entry.isDirectory()) {
          items.push({
            name: entry.name,
            path: relativePath,
            type: 'folder',
            children: scanDirectory(fullPath, relativePath)
          });
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          items.push({
            name: entry.name,
            path: relativePath,
            type: 'file'
          });
        }
      } catch (err) {
        console.warn(`⚠️  Error processing entry ${fullPath}:`, err.message);
        // Continue with other entries
      }
    }
  } catch (error) {
    console.error(`❌ Error scanning directory ${dir}:`, error.message);
    throw error;
  }

  return items.sort((a, b) => {
    // Folders first, then files, both alphabetically
    if (a.type !== b.type) {
      return a.type === 'folder' ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
}

// Helper function to broadcast file tree update
function broadcastFileTreeUpdate() {
  try {
    const fileTree = scanDirectory(BIN_FOLDER);
    io.emit('filetree:updated', { tree: fileTree, timestamp: Date.now() });
  } catch (error) {
    console.error('Error broadcasting file tree update:', error);
  }
}

// API 1: GET /api/files - Return file tree structure
app.get('/api/files', (req, res) => {
  try {
    const fileTree = scanDirectory(BIN_FOLDER);
    res.json(fileTree);
  } catch (error) {
    console.error('Error scanning files:', error);
    res.status(500).json({ error: 'Failed to scan files' });
  }
});

// API 2: GET /api/file?path=... - Read content of a specific .md file
app.get('/api/file', (req, res) => {
  try {
    const filePath = req.query.path;
    if (!filePath) {
      return res.status(400).json({ error: 'Path parameter is required' });
    }

    // Security: Prevent directory traversal
    const normalizedPath = path.normalize(filePath);
    if (normalizedPath.includes('..')) {
      return res.status(400).json({ error: 'Invalid path' });
    }

    const fullPath = path.join(BIN_FOLDER, normalizedPath);
    
    // Ensure the file is within the bin folder (cross-platform safe check)
    if (!isPathWithinBase(fullPath, BIN_FOLDER)) {
      return res.status(400).json({ error: 'Invalid path' });
    }

    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    const content = fs.readFileSync(fullPath, 'utf8');
    res.json({ content });
  } catch (error) {
    console.error('Error reading file:', error);
    res.status(500).json({ error: 'Failed to read file' });
  }
});

// API 3: POST /api/folder - Create a new folder
app.post('/api/folder', (req, res) => {
  try {
    const { path: folderPath } = req.body;
    
    if (!folderPath) {
      return res.status(400).json({ error: 'Path is required' });
    }

    // Security: Prevent directory traversal
    const normalizedPath = path.normalize(folderPath);
    if (normalizedPath.includes('..')) {
      return res.status(400).json({ error: 'Invalid path' });
    }

    const fullPath = path.join(BIN_FOLDER, normalizedPath);
    
    // Ensure the folder is within the bin folder (cross-platform safe check)
    if (!isPathWithinBase(fullPath, BIN_FOLDER)) {
      return res.status(400).json({ error: 'Invalid path' });
    }

    // Check if folder already exists
    if (fs.existsSync(fullPath)) {
      return res.status(400).json({ error: 'Folder already exists' });
    }

    // Create the folder
    fs.mkdirSync(fullPath, { recursive: true });
    res.json({ success: true, message: 'Folder created successfully' });
  } catch (error) {
    console.error('Error creating folder:', error);
    res.status(500).json({ error: 'Failed to create folder' });
  }
});

// API 4: POST /api/move - Move/rename file or folder
app.post('/api/move', (req, res) => {
  try {
    const { fromPath, toPath } = req.body;
    
    if (!fromPath || !toPath) {
      return res.status(400).json({ error: 'fromPath and toPath are required' });
    }

    // Security: Prevent directory traversal
    const normalizedFrom = path.normalize(fromPath);
    const normalizedTo = path.normalize(toPath);
    
    if (normalizedFrom.includes('..') || normalizedTo.includes('..')) {
      return res.status(400).json({ error: 'Invalid path' });
    }

    const fullFromPath = path.join(BIN_FOLDER, normalizedFrom);
    const fullToPath = path.join(BIN_FOLDER, normalizedTo);
    
    // Ensure paths are within the bin folder (cross-platform safe check)
    if (!isPathWithinBase(fullFromPath, BIN_FOLDER) || !isPathWithinBase(fullToPath, BIN_FOLDER)) {
      return res.status(400).json({ error: 'Invalid path' });
    }

    // Check if source exists
    if (!fs.existsSync(fullFromPath)) {
      return res.status(404).json({ error: 'Source file/folder not found' });
    }

    // Check if destination already exists
    if (fs.existsSync(fullToPath)) {
      return res.status(400).json({ error: 'Destination already exists' });
    }

    // Ensure destination directory exists
    const destDir = path.dirname(fullToPath);
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    // Move the file/folder
    fs.renameSync(fullFromPath, fullToPath);
    
    // Broadcast move operation
    broadcastFileTreeUpdate();
    io.emit('file:moved', { 
      fromPath: normalizedFrom, 
      toPath: normalizedTo,
      timestamp: Date.now()
    });
    
    res.json({ success: true, message: 'File/folder moved successfully' });
  } catch (error) {
    console.error('Error moving file/folder:', error);
    res.status(500).json({ error: 'Failed to move file/folder' });
  }
});

// API 5: POST /api/upload-image - Upload image file (base64)
app.post('/api/upload-image', (req, res) => {
  try {
    const { imageData, contentType } = req.body;
    
    if (!imageData) {
      return res.status(400).json({ error: 'No image data provided' });
    }

    // Remove data URL prefix if present (data:image/png;base64,...)
    let base64Data = imageData;
    let mimeType = contentType || 'image/png';
    
    if (imageData.includes(',')) {
      const parts = imageData.split(',');
      base64Data = parts[1];
      if (parts[0].includes(';base64')) {
        mimeType = parts[0].split(':')[1].split(';')[0];
      }
    }
    
    // Convert base64 to buffer
    const imageBuffer = Buffer.from(base64Data, 'base64');
    
    // Determine file extension from mime type
    const extMap = {
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/jpg': 'jpg',
      'image/gif': 'gif',
      'image/webp': 'webp',
      'image/svg+xml': 'svg'
    };
    const ext = extMap[mimeType] || 'png';
    
    // Generate unique filename
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 9);
    const filename = `image-${timestamp}-${random}.${ext}`;
    
    // Create images folder if it doesn't exist
    const imagesFolder = path.join(BIN_FOLDER, 'images');
    if (!fs.existsSync(imagesFolder)) {
      fs.mkdirSync(imagesFolder, { recursive: true });
    }
    
    const imagePath = path.join(imagesFolder, filename);
    
    // Save image file
    fs.writeFileSync(imagePath, imageBuffer);
    
    // Return relative path for markdown
    const relativePath = `images/${filename}`;
    res.json({ success: true, path: relativePath, url: `/api/image/${relativePath}` });
  } catch (error) {
    console.error('Error uploading image:', error);
    res.status(500).json({ error: 'Failed to upload image' });
  }
});

// API 6: GET /api/image/* - Serve uploaded images
app.get('/api/image/*', (req, res) => {
  try {
    const imagePath = req.params[0];
    const normalizedPath = path.normalize(imagePath);
    
    // Security: Prevent directory traversal
    if (normalizedPath.includes('..')) {
      return res.status(400).json({ error: 'Invalid path' });
    }
    
    const fullPath = path.join(BIN_FOLDER, normalizedPath);
    
    // Ensure the file is within the bin folder (cross-platform safe check)
    if (!isPathWithinBase(fullPath, BIN_FOLDER)) {
      return res.status(400).json({ error: 'Invalid path' });
    }
    
    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: 'Image not found' });
    }
    
    // Determine content type from extension
    const ext = path.extname(fullPath).toLowerCase();
    const contentTypeMap = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml'
    };
    const contentType = contentTypeMap[ext] || 'image/png';
    
    res.setHeader('Content-Type', contentType);
    res.sendFile(fullPath);
  } catch (error) {
    console.error('Error serving image:', error);
    res.status(500).json({ error: 'Failed to serve image' });
  }
});

// API 6: DELETE /api/delete - Delete file or folder
app.delete('/api/delete', (req, res) => {
  try {
    const { path: filePath } = req.body;
    
    if (!filePath) {
      return res.status(400).json({ error: 'Path is required' });
    }

    // Security: Prevent directory traversal
    const normalizedPath = path.normalize(filePath);
    if (normalizedPath.includes('..')) {
      return res.status(400).json({ error: 'Invalid path' });
    }

    const fullPath = path.join(BIN_FOLDER, normalizedPath);
    
    // Ensure the file is within the bin folder (cross-platform safe check)
    if (!isPathWithinBase(fullPath, BIN_FOLDER)) {
      return res.status(400).json({ error: 'Invalid path' });
    }

    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: 'File/folder not found' });
    }

    // Delete file or folder recursively
    if (fs.statSync(fullPath).isDirectory()) {
      fs.rmSync(fullPath, { recursive: true, force: true });
    } else {
      fs.unlinkSync(fullPath);
    }

    // Broadcast deletion
    broadcastFileTreeUpdate();
    io.emit('file:deleted', { 
      path: normalizedPath,
      timestamp: Date.now()
    });

    res.json({ success: true, message: 'File/folder deleted successfully' });
  } catch (error) {
    console.error('Error deleting file/folder:', error);
    res.status(500).json({ error: 'Failed to delete file/folder' });
  }
});

// API 7: POST /api/copy - Copy file or folder
app.post('/api/copy', (req, res) => {
  try {
    const { fromPath, toPath } = req.body;
    
    if (!fromPath || !toPath) {
      return res.status(400).json({ error: 'fromPath and toPath are required' });
    }

    // Security: Prevent directory traversal
    const normalizedFrom = path.normalize(fromPath);
    const normalizedTo = path.normalize(toPath);
    
    if (normalizedFrom.includes('..') || normalizedTo.includes('..')) {
      return res.status(400).json({ error: 'Invalid path' });
    }

    const fullFromPath = path.join(BIN_FOLDER, normalizedFrom);
    const fullToPath = path.join(BIN_FOLDER, normalizedTo);
    
    // Ensure paths are within the bin folder (cross-platform safe check)
    if (!isPathWithinBase(fullFromPath, BIN_FOLDER) || !isPathWithinBase(fullToPath, BIN_FOLDER)) {
      return res.status(400).json({ error: 'Invalid path' });
    }

    // Check if source exists
    if (!fs.existsSync(fullFromPath)) {
      return res.status(404).json({ error: 'Source file/folder not found' });
    }

    // Check if destination already exists
    if (fs.existsSync(fullToPath)) {
      return res.status(400).json({ error: 'Destination already exists' });
    }

    // Ensure destination directory exists
    const destDir = path.dirname(fullToPath);
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    // Copy file or folder
    if (fs.statSync(fullFromPath).isDirectory()) {
      // Copy directory recursively
      function copyDir(src, dest) {
        fs.mkdirSync(dest, { recursive: true });
        const entries = fs.readdirSync(src, { withFileTypes: true });
        for (const entry of entries) {
          const srcPath = path.join(src, entry.name);
          const destPath = path.join(dest, entry.name);
          if (entry.isDirectory()) {
            copyDir(srcPath, destPath);
          } else {
            fs.copyFileSync(srcPath, destPath);
          }
        }
      }
      copyDir(fullFromPath, fullToPath);
    } else {
      fs.copyFileSync(fullFromPath, fullToPath);
    }

    // Broadcast copy operation
    broadcastFileTreeUpdate();
    io.emit('file:copied', { 
      fromPath: normalizedFrom, 
      toPath: normalizedTo,
      timestamp: Date.now()
    });

    res.json({ success: true, message: 'File/folder copied successfully' });
  } catch (error) {
    console.error('Error copying file/folder:', error);
    res.status(500).json({ error: 'Failed to copy file/folder' });
  }
});

// API 8: POST /api/rename - Rename file or folder
app.post('/api/rename', (req, res) => {
  try {
    const { path: filePath, newName } = req.body;
    
    if (!filePath || !newName) {
      return res.status(400).json({ error: 'Path and newName are required' });
    }

    // Security: Prevent directory traversal
    const normalizedPath = path.normalize(filePath);
    if (normalizedPath.includes('..') || newName.includes('..')) {
      return res.status(400).json({ error: 'Invalid path or name' });
    }

    const fullPath = path.join(BIN_FOLDER, normalizedPath);
    
    // Ensure the file is within the bin folder (cross-platform safe check)
    if (!isPathWithinBase(fullPath, BIN_FOLDER)) {
      return res.status(400).json({ error: 'Invalid path' });
    }

    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: 'File/folder not found' });
    }

    // Get directory and construct new path
    const dir = path.dirname(fullPath);
    const newPath = path.join(dir, newName);
    
    // Check if new name already exists
    if (fs.existsSync(newPath)) {
      return res.status(400).json({ error: 'A file/folder with this name already exists' });
    }

    // Rename (move)
    fs.renameSync(fullPath, newPath);

    // Calculate relative path for response
    const relativeNewPath = path.relative(BIN_FOLDER, newPath).replace(/\\/g, '/');
    
    // Broadcast rename operation
    broadcastFileTreeUpdate();
    io.emit('file:renamed', { 
      oldPath: normalizedPath, 
      newPath: relativeNewPath,
      timestamp: Date.now()
    });
    
    res.json({ success: true, message: 'File/folder renamed successfully', newPath: relativeNewPath });
  } catch (error) {
    console.error('Error renaming file/folder:', error);
    res.status(500).json({ error: 'Failed to rename file/folder' });
  }
});

// API 9: POST /api/save - Save file content
app.post('/api/save', (req, res) => {
  try {
    const { path: filePath, content } = req.body;
    
    if (!filePath) {
      return res.status(400).json({ error: 'Path is required' });
    }

    if (content === undefined) {
      return res.status(400).json({ error: 'Content is required' });
    }

    // Security: Prevent directory traversal
    const normalizedPath = path.normalize(filePath);
    if (normalizedPath.includes('..')) {
      return res.status(400).json({ error: 'Invalid path' });
    }

    const fullPath = path.join(BIN_FOLDER, normalizedPath);
    
    // Ensure the file is within the bin folder (cross-platform safe check)
    if (!isPathWithinBase(fullPath, BIN_FOLDER)) {
      return res.status(400).json({ error: 'Invalid path' });
    }

    // Ensure the directory exists
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(fullPath, content, 'utf8');
    res.json({ success: true, message: 'File saved successfully' });
  } catch (error) {
    console.error('Error saving file:', error);
    res.status(500).json({ error: 'Failed to save file' });
  }
});

// Function to open browser
function openBrowser(url) {
  const platform = process.platform;
  let command;
  
  if (platform === 'win32') {
    command = `start "" "${url}"`;
  } else if (platform === 'darwin') {
    command = `open "${url}"`;
  } else {
    command = `xdg-open "${url}"`;
  }
  
  exec(command, (error) => {
    if (error) {
      console.log(`Could not open browser automatically. Please open: ${url}`);
    }
  });
}

// Get LAN IP address
function getLANIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      // Skip internal (loopback) and non-IPv4 addresses
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log(`📡 Client connected: ${socket.id}`);
  
  // Send current file tree to new client
  socket.on('filetree:request', () => {
    try {
      const fileTree = scanDirectory(BIN_FOLDER);
      socket.emit('filetree:updated', { tree: fileTree, timestamp: Date.now() });
    } catch (error) {
      console.error('Error sending file tree to client:', error);
    }
  });
  
  // Handle realtime file editing - broadcast to all other clients
  socket.on('file:edit', (data) => {
    // Broadcast to all other clients (excluding the sender)
    socket.broadcast.emit('file:edit', {
      path: data.path,
      content: data.content,
      timestamp: Date.now()
    });
  });
  
  socket.on('disconnect', () => {
    console.log(`📡 Client disconnected: ${socket.id}`);
  });
});

// Start server
server.listen(PORT, '0.0.0.0', () => {
  const localUrl = `http://localhost:${PORT}`;
  const lanIP = getLANIP();
  const lanUrl = `http://${lanIP}:${PORT}`;
  
  console.log('='.repeat(60));
  console.log(`🚀 MyHackMD Server is running!`);
  console.log(`📝 Local Interface: ${localUrl}`);
  console.log(`🌐 LAN Interface: ${lanUrl}`);
  console.log(`📁 Files stored in: ${BIN_FOLDER}`);
  console.log(`📡 Realtime sync: Enabled (Socket.IO)`);
  console.log('='.repeat(60));
  console.log(`\n💡 Other devices on your network can access:`);
  console.log(`   ${lanUrl}\n`);
  
  // Open browser automatically
  setTimeout(() => {
    openBrowser(localUrl);
  }, 1000);
});

