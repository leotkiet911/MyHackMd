// Global state
let currentFilePath = null;
let md = null;
let saveTimeout = null;
let fileTreeData = [];
let codeEditor = null;
let selectedFolderPath = null; // Track selected folder for creating files
let draggedElement = null; // Track dragged element for drag and drop
let socket = null; // Socket.IO connection
let isUpdatingFromSocket = false; // Flag to prevent circular updates
let lastBroadcastedContent = ''; // Track last content sent to server
let socketChangeTimeout = null; // Debounce for socket changes
let isTyping = false; // Flag to check if user is typing (prevents scroll sync jank)
let typingTimeout = null; // Timeout to reset typing flag
let lineToPixelMapping = null; // Cache for line to pixel mapping
let mappingCacheTimestamp = 0; // Timestamp for cache validation

// Markdown-it container plugin (for ::: info, ::: success, etc.)
function markdownItContainer(md, name) {
    function container(state, startLine, endLine, silent) {
        const marker = ':::';
        const minMarkerLength = 3;
        
        // Skip if indented too much
        if (state.sCount[startLine] - state.blkIndent >= 4) {
            return false;
        }
        
        let pos = state.bMarks[startLine] + state.tShift[startLine];
        let max = state.eMarks[startLine];
        
        // Check for opening marker
        if (pos + minMarkerLength > max) {
            return false;
        }
        
        const markerStr = state.src.slice(pos, pos + minMarkerLength);
        if (markerStr !== marker) {
            return false;
        }
        
        pos += minMarkerLength;
        
        // Skip whitespace after marker
        while (pos < max) {
            const ch = state.src.charCodeAt(pos);
            if (ch !== 0x20 && ch !== 0x09) break;
            pos++;
        }
        
        // Read container type (info, success, warning, danger, etc.)
        let containerType = '';
        const typeStart = pos;
        while (pos < max) {
            const ch = state.src.charCodeAt(pos);
            if (ch === 0x0A || ch === 0x0D) break;
            containerType += state.src[pos];
            pos++;
        }
        
        containerType = containerType.trim();
        if (containerType.length === 0) {
            return false;
        }
        
        // Find closing marker
        let nextLine = startLine;
        let haveEndMarker = false;
        
        for (;;) {
            nextLine++;
            if (nextLine >= endLine) {
                break;
            }
            
            pos = state.bMarks[nextLine] + state.tShift[nextLine];
            max = state.eMarks[nextLine];
            
            // Check if line is indented less than container
            if (state.sCount[nextLine] < state.blkIndent) {
                break;
            }
            
            // Check for closing marker
            if (pos + minMarkerLength <= max) {
                const markerCheck = state.src.slice(pos, pos + minMarkerLength);
                if (markerCheck === marker) {
                    haveEndMarker = true;
                    break;
                }
            }
        }
        
        if (!haveEndMarker) {
            return false;
        }
        
        const oldParent = state.parentType;
        const oldLineMax = state.lineMax;
        
        state.parentType = 'container';
        
        const token = state.push('container_' + containerType + '_open', 'div', 1);
        token.markup = marker;
        token.block = true;
        token.info = containerType;
        token.map = [startLine, nextLine];
        
        // Tokenize content between markers
        state.md.block.tokenize(state, startLine + 1, nextLine);
        
        const tokenClose = state.push('container_' + containerType + '_close', 'div', -1);
        tokenClose.markup = marker;
        tokenClose.block = true;
        
        state.parentType = oldParent;
        state.lineMax = oldLineMax;
        state.line = nextLine + 1;
        
        return true;
    }
    
    md.block.ruler.before('fence', 'container_' + name, container, {
        alt: ['paragraph', 'reference', 'blockquote', 'list']
    });
}

// Initialize markdown-it with containers and math support
function initMarkdown() {
    if (typeof markdownit === 'undefined') {
        console.error('markdown-it not loaded');
        return;
    }
    
    // Initialize markdown-it with generic HTML support
    md = window.markdownit({
        html: true,
        breaks: true, // Converts \n to <br>
        linkify: true
    });
    
    // Use texmath plugin with 'dollars' delimiters
    // This enables:
    // $...$ -> Inline math
    // $$...$$ -> Display math (Block, centered, new line)
    if (typeof texmath !== 'undefined') {
        md.use(texmath, {
            engine: katex,
            delimiters: 'dollars',
            katexOptions: { 
                macros: { 
                    "\\RR": "\\mathbb{R}",
                    // Auto-convert \frac to \dfrac for larger display
                    "\\frac": "\\dfrac"
                },
                throwOnError: false,
                strict: false
            }
        });
    } else if (typeof window.texmath !== 'undefined') {
        md.use(window.texmath, {
            engine: katex,
            delimiters: 'dollars',
            katexOptions: { 
                macros: { 
                    "\\RR": "\\mathbb{R}",
                    // Auto-convert \frac to \dfrac for larger display
                    "\\frac": "\\dfrac"
                },
                throwOnError: false,
                strict: false
            }
        });
    } else {
        console.warn('texmath plugin not loaded, math rendering may not work properly');
    }
    
    // Add container plugin for ::: blocks
    const containerTypes = ['info', 'success', 'warning', 'danger', 'note', 'tip'];
    containerTypes.forEach(type => {
        markdownItContainer(md, type);
    });
    
    // Custom renderer for container blocks
    containerTypes.forEach(type => {
        md.renderer.rules['container_' + type + '_open'] = function(tokens, idx) {
            return '<div class="markdown-container markdown-container-' + type + '">\n';
        };
        
        md.renderer.rules['container_' + type + '_close'] = function(tokens, idx) {
            return '</div>\n';
        };
    });
}

// Debounce function
function debounce(func, wait) {
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(saveTimeout);
            func(...args);
        };
        clearTimeout(saveTimeout);
        saveTimeout = setTimeout(later, wait);
    };
}

// Fetch file tree from API
async function fetchFileTree() {
    try {
        const response = await fetch('/api/files');
        if (!response.ok) throw new Error('Failed to fetch files');
        fileTreeData = await response.json();
        renderFileTree(fileTreeData);
    } catch (error) {
        console.error('Error fetching file tree:', error);
        document.getElementById('fileTree').innerHTML = 
            '<div class="loading" style="color: #f48771;">Error loading files</div>';
    }
}

// Render file tree in sidebar (Windows Explorer style)
function renderFileTree(tree, container = null, level = 0) {
    const fileTreeEl = container || document.getElementById('fileTree');
    
    if (level === 0) {
        fileTreeEl.innerHTML = '';
    }

    if (tree.length === 0 && level === 0) {
        fileTreeEl.innerHTML = '<div class="loading">No files found. Create a new file!</div>';
        return;
    }

    tree.forEach(item => {
        const itemEl = document.createElement('div');
        itemEl.className = `file-item ${item.type}`;
        itemEl.dataset.path = item.path;
        
        const hasChildren = item.type === 'folder' && item.children && item.children.length > 0;
        const isExpanded = item.type === 'folder' && item.expanded !== false; // Default expanded
        
        if (item.type === 'file') {
            itemEl.innerHTML = `
                <span class="file-icon">📄</span>
                <span class="file-name">${escapeHtml(item.name)}</span>
            `;
            
            // Make file draggable
            itemEl.draggable = true;
            itemEl.dataset.type = 'file';
            itemEl.dataset.name = item.name;
            
            itemEl.addEventListener('click', (e) => {
                e.stopPropagation();
                loadFile(item.path);
            });
            
            // Right-click context menu
            itemEl.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
                showContextMenu(e, item.path, item.name, 'file');
            });
            
            // Drag and drop handlers
            itemEl.addEventListener('dragstart', handleDragStart);
            itemEl.addEventListener('dragend', handleDragEnd);
        } else {
            // Folder with expand/collapse toggle
            itemEl.innerHTML = `
                <span class="folder-toggle ${isExpanded ? 'expanded' : 'collapsed'}">▶</span>
                <span class="file-icon">${isExpanded ? '📂' : '📁'}</span>
                <span class="file-name">${escapeHtml(item.name)}</span>
            `;
            
            // Make folder draggable and droppable
            itemEl.draggable = true;
            itemEl.dataset.type = 'folder';
            itemEl.dataset.name = item.name;
            
            // Toggle on folder click (on toggle arrow or icon)
            const toggleEl = itemEl.querySelector('.folder-toggle');
            const iconEl = itemEl.querySelector('.file-icon');
            const nameEl = itemEl.querySelector('.file-name');
            
            toggleEl.addEventListener('click', (e) => {
                e.stopPropagation();
                toggleFolder(itemEl, item);
            });
            
            // Select folder on name/icon click (for creating files inside)
            nameEl.addEventListener('click', (e) => {
                e.stopPropagation();
                selectFolder(item.path, itemEl);
            });
            
            iconEl.addEventListener('click', (e) => {
                e.stopPropagation();
                selectFolder(item.path, itemEl);
            });
            
            // Right-click context menu
            itemEl.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
                showContextMenu(e, item.path, item.name, 'folder');
            });
            
            // Drag and drop handlers
            itemEl.addEventListener('dragstart', handleDragStart);
            itemEl.addEventListener('dragover', handleDragOver);
            itemEl.addEventListener('drop', handleDrop);
            itemEl.addEventListener('dragend', handleDragEnd);
        }

        fileTreeEl.appendChild(itemEl);

        if (hasChildren) {
            const childrenEl = document.createElement('div');
            childrenEl.className = `folder-children ${isExpanded ? 'expanded' : ''}`;
            itemEl.appendChild(childrenEl);
            renderFileTree(item.children, childrenEl, level + 1);
        }
    });
}

// Toggle folder expand/collapse (Windows Explorer style)
function toggleFolder(element, item) {
    const children = element.querySelector('.folder-children');
    const toggle = element.querySelector('.folder-toggle');
    const icon = element.querySelector('.file-icon');
    
    if (children) {
        const isExpanded = children.classList.contains('expanded');
        
        if (isExpanded) {
            children.classList.remove('expanded');
            toggle.classList.remove('expanded');
            toggle.classList.add('collapsed');
            icon.textContent = '📁';
            if (item) item.expanded = false;
        } else {
            children.classList.add('expanded');
            toggle.classList.remove('collapsed');
            toggle.classList.add('expanded');
            icon.textContent = '📂';
            if (item) item.expanded = true;
        }
    }
}

// Update file name display in headers
function updateFileNameDisplay(filePath) {
    const editorFileNameEl = document.getElementById('editorFileName');
    const previewFileNameEl = document.getElementById('previewFileName');
    
    if (filePath) {
        // Extract just the filename from path
        const fileName = filePath.split('/').pop() || filePath;
        const displayName = fileName;
        
        if (editorFileNameEl) {
            editorFileNameEl.textContent = displayName;
        }
        if (previewFileNameEl) {
            previewFileNameEl.textContent = displayName;
        }
    } else {
        // Clear file name when no file is open
        if (editorFileNameEl) {
            editorFileNameEl.textContent = '';
        }
        if (previewFileNameEl) {
            previewFileNameEl.textContent = '';
        }
    }
}

// Load file content
async function loadFile(filePath) {
    // Reset broadcast content when loading new file
    lastBroadcastedContent = '';
    try {
        // Update active state
        document.querySelectorAll('.file-item').forEach(el => {
            el.classList.remove('active');
        });
        const activeEl = document.querySelector(`[data-path="${filePath}"]`);
        if (activeEl) {
            activeEl.classList.add('active');
        }

        const response = await fetch(`/api/file?path=${encodeURIComponent(filePath)}`);
        if (!response.ok) throw new Error('Failed to fetch file');
        
        const data = await response.json();
        currentFilePath = filePath;
        
        // Update file name display
        updateFileNameDisplay(filePath);
        
        // Update CodeMirror editor
        if (codeEditor) {
            isUpdatingFromSocket = true;
            codeEditor.setValue(data.content);
            lastBroadcastedContent = data.content;
            isUpdatingFromSocket = false;
        }
        
        updatePreview(data.content);
    } catch (error) {
        console.error('Error loading file:', error);
        alert('Failed to load file: ' + error.message);
    }
}

// Process containers after markdown rendering
function processContainers(html) {
    if (!html) return html;
    
    // Pattern: ::: type [title] followed by content and :::
    // We need to find these in the original markdown and convert them
    // Since we're working with HTML, we'll use a different approach:
    // Replace container markers that weren't processed by markdown
    
    // This is a simpler approach: process containers in the markdown before rendering
    return html;
}

// Preprocess containers: convert ::: blocks to HTML before markdown rendering
function preprocessContainers(content) {
    if (!content) return content;

    const lines = content.split('\n');
    const result = [];
    let inContainer = false;
    let containerType = '';
    let containerTitle = '';
    let containerLines = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        // Check for container start ::: type [title]
        if (trimmed.startsWith(':::') && !inContainer) {
            inContainer = true;
            
            // Get content after :::
            const afterColons = trimmed.substring(3).trim();
            const parts = afterColons.split(/\s+/).filter(p => p.length > 0);

            if (parts.length > 0) {
                // Case 1: Type is on the same line (e.g. ::: success)
                containerType = parts[0];
                containerTitle = parts.slice(1).join(' ') || '';
            } else {
                // Case 2: Type is on subsequent lines
                // FIX: Use a loop to skip empty lines and find the type
                containerType = 'info'; // Default fallback
                containerTitle = '';

                // Start searching from the next line
                let j = i + 1;
                while (j < lines.length) {
                    const nextLine = lines[j].trim();
                    
                    // If line is empty, keep looking
                    if (nextLine.length === 0) {
                        j++;
                        continue;
                    }
                    
                    // If we hit a closing delimiter ':::', stop looking
                    // (This means the container is truly empty/info)
                    if (nextLine === ':::') {
                        break;
                    }
                    
                    // Found a non-empty line that isn't ':::'
                    // This must be the type definition
                    const nextLineParts = nextLine.split(/\s+/);
                    containerType = nextLineParts[0];
                    containerTitle = nextLineParts.slice(1).join(' ') || '';
                    
                    // Update the main loop index 'i' to 'j' 
                    // so we don't process these lines again as content
                    i = j;
                    break;
                }
            }
            
            containerLines = [];
            continue;
        }

        // Check for container end :::
        if (trimmed === ':::' && inContainer) {
            inContainer = false;

            const containerContent = containerLines.join('\n');
            const renderedContent = (typeof md !== 'undefined' && md) ? md.render(containerContent) : containerContent;

            const containerClass = 'markdown-container markdown-container-' + containerType;
            let containerHtml = '<div class="' + containerClass + '">';
            
            if (containerTitle) {
                 // Simple escape for title to prevent HTML injection
                const safeTitle = containerTitle.replace(/&/g, "&amp;")
                                                .replace(/</g, "&lt;")
                                                .replace(/>/g, "&gt;")
                                                .replace(/"/g, "&quot;")
                                                .replace(/'/g, "&#039;");
                containerHtml += '<strong>' + safeTitle + '</strong>';
            }
            
            if (containerContent.trim()) {
                containerHtml += renderedContent;
            }
            containerHtml += '</div>';
            
            result.push(containerHtml);
            containerLines = [];
            continue;
        }

        if (inContainer) {
            containerLines.push(line);
        } else {
            result.push(line);
        }
    }

    // Close any unclosed containers
    if (inContainer) {
        result.push(':::' + (containerType ? ' ' + containerType : '') + (containerTitle ? ' ' + containerTitle : ''));
        result.push(...containerLines);
    }

    return result.join('\n');
}

// Preprocess math to auto-add \left and \right to brackets around fractions
function preprocessMathBrackets(content) {
    if (!content) return content;
    
    // Process both inline $...$ and block $$...$$ math
    // Auto-add \left and \right to brackets that contain fractions
    
    // Helper to find matching closing bracket
    const findMatchingBracket = (str, startPos, openChar, closeChar) => {
        let depth = 1;
        let pos = startPos + 1;
        while (pos < str.length && depth > 0) {
            if (str[pos] === openChar && (pos === 0 || str[pos - 1] !== '\\')) {
                depth++;
            } else if (str[pos] === closeChar && (pos === 0 || str[pos - 1] !== '\\')) {
                depth--;
            }
            pos++;
        }
        return depth === 0 ? pos - 1 : -1;
    };
    
    // Helper to process a single math expression
    const processMath = (math) => {
        // Check if this expression contains fractions
        if (!/(\\frac|\\dfrac)/.test(math)) {
            return math; // No fractions, skip
        }
        
        let result = math;
        const bracketPairs = [
            { open: '(', close: ')', left: '\\left(', right: '\\right)' },
            { open: '[', close: ']', left: '\\left[', right: '\\right]' }
        ];
        
        // Process each bracket type
        for (const bp of bracketPairs) {
            let pos = 0;
            while (pos < result.length) {
                // Find opening bracket (not escaped and not already part of \left)
                const openPos = result.indexOf(bp.open, pos);
                if (openPos === -1) break;
                
                // Check if it's escaped
                if (openPos > 0 && result[openPos - 1] === '\\') {
                    pos = openPos + 1;
                    continue;
                }
                
                // Check if it's already part of \left(...)
                const beforeBracket = result.substring(Math.max(0, openPos - 6), openPos);
                if (beforeBracket.endsWith('\\left')) {
                    // Already has \left, skip this bracket pair
                    // Find matching closing bracket and skip it
                    const closePos = findMatchingBracket(result, openPos, bp.open, bp.close);
                    pos = closePos > 0 ? closePos + 1 : openPos + 1;
                    continue;
                }
                
                // Find matching closing bracket
                const closePos = findMatchingBracket(result, openPos, bp.open, bp.close);
                if (closePos === -1) {
                    pos = openPos + 1;
                    continue;
                }
                
                // Check if closing bracket is already part of \right)
                const afterBracket = result.substring(closePos + 1, Math.min(result.length, closePos + 7));
                if (afterBracket.startsWith('\\right')) {
                    // Already has \right, skip
                    pos = closePos + 1;
                    continue;
                }
                
                // Extract content between brackets
                const inner = result.substring(openPos + 1, closePos);
                
                // Check if inner content contains a fraction
                if (/(\\frac|\\dfrac)/.test(inner)) {
                    // Replace with \left and \right
                    result = result.substring(0, openPos) + 
                            bp.left + inner + bp.right + 
                            result.substring(closePos + 1);
                    // Continue from after the replacement
                    pos = openPos + bp.left.length + inner.length + bp.right.length;
                } else {
                    pos = closePos + 1;
                }
            }
        }
        
        return result;
    };
    
    // Process inline math $...$
    content = content.replace(/\$([^$\n]+)\$/g, (match, math) => {
        return '$' + processMath(math) + '$';
    });
    
    // Process block math $$...$$
    content = content.replace(/\$\$([\s\S]*?)\$\$/g, (match, math) => {
        return '$$' + processMath(math) + '$$';
    });
    
    return content;
}

// Preprocess math blocks to protect them from markdown processing
function preprocessMath(content) {
    if (!content) return content;
    
    // Protect block math $$...$$ by converting to code fence temporarily
    const mathBlocks = [];
    let blockCounter = 0;
    
    // Replace $$...$$ with placeholders
    content = content.replace(/\$\$([\s\S]*?)\$\$/g, function(match, math) {
        const placeholder = `__MATH_BLOCK_${blockCounter}__`;
        mathBlocks[blockCounter] = math;
        blockCounter++;
        return placeholder;
    });
    
    // Render markdown
    let html = md.render(content);
    
    // Restore math blocks
    mathBlocks.forEach((math, index) => {
        const placeholder = `__MATH_BLOCK_${index}__`;
        // Find placeholder in HTML and replace with protected math
        const placeholderRegex = new RegExp(escapeRegex(placeholder), 'g');
        html = html.replace(placeholderRegex, `$$${math}$$`);
    });
    
    return html;
}

// Helper to escape regex special characters
function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Update preview with markdown rendering
function updatePreview(content) {
    const previewEl = document.getElementById('preview');
    if (md && content) {
        // Preprocess math brackets first (auto-add \left and \right around fractions)
        let processedContent = preprocessMathBrackets(content);
        
        // Preprocess containers (convert to HTML)
        processedContent = preprocessContainers(processedContent);
        
        // Render markdown (texmath plugin will handle math automatically)
        let html = md.render(processedContent);
        
        // --- FIX START: Logic Ghim đáy (Pin to Bottom) ---
        // 1. Kiểm tra xem user có đang đứng sát đáy Preview không (sai số 50px)
        const wasAtBottom = previewEl.scrollHeight - previewEl.scrollTop <= previewEl.clientHeight + 50;
        
        previewEl.innerHTML = html;
        
        // 2. Nếu trước đó đang ở đáy, thì sau khi render ép lại xuống đáy ngay lập tức
        if (wasAtBottom) {
            previewEl.scrollTop = previewEl.scrollHeight;
        }
        // --- FIX END ---
        
        // --- FIX: Xử lý ảnh để tránh Layout Shift ---
        const images = previewEl.querySelectorAll('img');
        images.forEach(img => {
            // Khi ảnh load xong, nếu đang chế độ ghim đáy thì ghim tiếp
            // Vì ảnh load xong làm trang dài ra (scrollHeight tăng), cần cuộn tiếp xuống
            img.addEventListener('load', () => {
                // Invalidate mapping cache because image height changed
                lineToPixelMapping = null;
                
                if (wasAtBottom) {
                    previewEl.scrollTop = previewEl.scrollHeight;
                }
            });
            
            // Invalidate cache on error too
            img.addEventListener('error', () => {
                lineToPixelMapping = null;
            });
        });
        // --- FIX END ---
    } else {
        previewEl.innerHTML = '<p style="color: #999;">Preview will appear here...</p>';
    }
}

// Save file content
async function saveFile() {
    if (!currentFilePath) {
        updateSaveStatus('No file selected', false);
        return;
    }

    const content = codeEditor ? codeEditor.getValue() : '';
    
    updateSaveStatus('Saving...', true);

    try {
        const response = await fetch('/api/save', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                path: currentFilePath,
                content: content
            })
        });

        if (!response.ok) throw new Error('Failed to save file');
        
        updateSaveStatus('Saved', false);
        
        // File tree will be updated via Socket.IO if needed
        // Only refresh if it's a new file
        if (!fileTreeData.some(item => findItemByPath(fileTreeData, currentFilePath))) {
            fetchFileTree();
        }
    } catch (error) {
        console.error('Error saving file:', error);
        updateSaveStatus('Error saving', false);
    }
}

// Update save status indicator
function updateSaveStatus(message, isSaving) {
    const statusEl = document.getElementById('saveStatus');
    statusEl.textContent = message;
    statusEl.className = 'save-status' + (isSaving ? ' saving' : message === 'Saved' ? ' saved' : '');
    
    if (message === 'Saved') {
        setTimeout(() => {
            if (statusEl.textContent === 'Saved') {
                statusEl.textContent = '';
                statusEl.className = 'save-status';
            }
        }, 2000);
    }
}

// Select folder for creating files inside
function selectFolder(folderPath, element) {
    // Remove previous selection
    document.querySelectorAll('.file-item').forEach(el => {
        el.classList.remove('folder-selected');
    });
    
    // Add selection to current folder
    if (element) {
        element.classList.add('folder-selected');
    }
    
    selectedFolderPath = folderPath;
    
    // Expand folder if collapsed
    const children = element?.querySelector('.folder-children');
    if (children && !children.classList.contains('expanded')) {
        const item = fileTreeData.find(item => findItemByPath(fileTreeData, folderPath));
        toggleFolder(element, item);
    }
}

// Helper to find item in tree by path
function findItemByPath(tree, targetPath) {
    for (const item of tree) {
        if (item.path === targetPath) return item;
        if (item.children) {
            const found = findItemByPath(item.children, targetPath);
            if (found) return found;
        }
    }
    return null;
}

// Create new file
function createNewFile() {
    let basePath = '';
    if (selectedFolderPath) {
        basePath = selectedFolderPath + '/';
    }
    
    const fileName = prompt(`Enter file name${selectedFolderPath ? ` (will be created in: ${selectedFolderPath})` : ''}:\n\nExample: new-file.md`, '');
    if (!fileName) return;

    // Ensure .md extension
    const finalName = fileName.endsWith('.md') ? fileName : fileName + '.md';
    const filePath = basePath + finalName;

    // Set current file path and clear editor
    currentFilePath = filePath;
    // Update file name display
    updateFileNameDisplay(filePath);
    if (codeEditor) {
        codeEditor.setValue('');
    }
    updatePreview('');

    // Save empty file to create it
    saveFile().then(() => {
        // Refresh file tree and load the new file
        fetchFileTree().then(() => {
            setTimeout(() => {
                loadFile(filePath);
                // Clear folder selection
                selectedFolderPath = null;
                document.querySelectorAll('.file-item').forEach(el => {
                    el.classList.remove('folder-selected');
                });
            }, 300);
        });
    });
}

// Create new folder
async function createNewFolder() {
    const folderName = prompt('Enter folder name (e.g., my-folder or parent/child):');
    if (!folderName) return;

    const folderPath = folderName;

    try {
        const response = await fetch('/api/folder', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                path: folderPath
            })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to create folder');
        }

        // Refresh file tree
        await fetchFileTree();
    } catch (error) {
        console.error('Error creating folder:', error);
        alert('Failed to create folder: ' + error.message);
    }
}

// Escape HTML to prevent XSS
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Container types for autocomplete
const containerTypes = [
    { type: 'info', label: 'Info - Thông tin' },
    { type: 'success', label: 'Success - Thành công' },
    { type: 'warning', label: 'Warning - Cảnh báo' },
    { type: 'danger', label: 'Danger - Nguy hiểm' },
    { type: 'note', label: 'Note - Ghi chú' },
    { type: 'tip', label: 'Tip - Mẹo' }
];

// Autocomplete function for ::: containers
function containerHint(editor, options) {
    const cursor = editor.getCursor();
    const line = editor.getLine(cursor.line);
    const pos = cursor.ch;
    const beforeCursor = line.substring(0, pos);
    
    let from, to, list;
    
    const makeText = (type) => `::: ${type}\n\n:::\n`;

    if (beforeCursor.trim() === ':::' || beforeCursor.match(/^:::\s*$/)) {
        from = CodeMirror.Pos(cursor.line, 0); 
        to = CodeMirror.Pos(cursor.line, pos);
        
        list = containerTypes.map(ct => {
            return {
                text: makeText(ct.type), 
                displayText: ct.label,
                render: function(el, self, data) {
                    el.innerHTML = `<strong>${data.displayText}</strong>`;
                }
            };
        });
        
        return { list, from, to };
    }
    
    const match = beforeCursor.match(/^:::\s+(\w*)$/);
    if (match) {
        const typed = match[1].toLowerCase();
        const filtered = containerTypes.filter(ct => 
            ct.type.toLowerCase().startsWith(typed) || 
            ct.label.toLowerCase().includes(typed)
        );
        
        if (filtered.length > 0) {
            from = CodeMirror.Pos(cursor.line, 0);
            to = CodeMirror.Pos(cursor.line, pos);
            
            list = filtered.map(ct => {
                return {
                    text: makeText(ct.type), 
                    displayText: ct.label,
                    render: function(el, self, data) {
                        el.innerHTML = `<strong>${data.displayText}</strong>`;
                    }
                };
            });
            
            return { list, from, to };
        }
    }
    
    return null;
}

// Initialize CodeMirror editor with all shortcuts
function initCodeEditor() {
    const editorEl = document.getElementById('editor');
    
    if (typeof CodeMirror !== 'undefined') {
        codeEditor = CodeMirror(editorEl, {
            mode: 'markdown',
            theme: 'monokai',
            lineNumbers: true,
            lineWrapping: true,
            autoCloseBrackets: true,
            matchBrackets: true,
            styleActiveLine: true,
            indentUnit: 2,
            tabSize: 2,
            indentWithTabs: false,
            autofocus: true,
            extraKeys: {
                // Undo/Redo
                "Ctrl-Z": function(cm) { cm.undo(); },
                "Cmd-Z": function(cm) { cm.undo(); },
                "Ctrl-Y": function(cm) { cm.redo(); },
                "Shift-Ctrl-Z": function(cm) { cm.redo(); },
                "Shift-Cmd-Z": function(cm) { cm.redo(); },
                
                // Cut/Delete line
                "Ctrl-X": function(cm) {
                    if (cm.somethingSelected()) {
                        cm.replaceSelection("");
                    } else {
                        const line = cm.getCursor().line;
                        cm.replaceRange("", CodeMirror.Pos(line, 0), CodeMirror.Pos(line + 1, 0));
                    }
                },
                "Cmd-X": function(cm) {
                    if (cm.somethingSelected()) {
                        cm.replaceSelection("");
                    } else {
                        const line = cm.getCursor().line;
                        cm.replaceRange("", CodeMirror.Pos(line, 0), CodeMirror.Pos(line + 1, 0));
                    }
                },
                "Shift-Ctrl-K": function(cm) {
                    const line = cm.getCursor().line;
                    cm.replaceRange("", CodeMirror.Pos(line, 0), CodeMirror.Pos(line + 1, 0));
                },
                "Shift-Cmd-K": function(cm) {
                    const line = cm.getCursor().line;
                    cm.replaceRange("", CodeMirror.Pos(line, 0), CodeMirror.Pos(line + 1, 0));
                },
                
                // Move line up/down
                "Alt-Up": function(cm) {
                    const cursor = cm.getCursor();
                    if (cursor.line > 0) {
                        const line = cm.getLine(cursor.line);
                        cm.replaceRange("", CodeMirror.Pos(cursor.line, 0), CodeMirror.Pos(cursor.line + 1, 0));
                        cm.replaceRange(line + "\n", CodeMirror.Pos(cursor.line - 1, 0));
                        cm.setCursor(cursor.line - 1, cursor.ch);
                    }
                },
                "Alt-Down": function(cm) {
                    const cursor = cm.getCursor();
                    const lineCount = cm.lineCount();
                    if (cursor.line < lineCount - 1) {
                        const line = cm.getLine(cursor.line);
                        cm.replaceRange("", CodeMirror.Pos(cursor.line, 0), CodeMirror.Pos(cursor.line + 1, 0));
                        cm.replaceRange(line + "\n", CodeMirror.Pos(cursor.line + 1, 0));
                        cm.setCursor(cursor.line + 1, cursor.ch);
                    }
                },
                "Option-Up": function(cm) {
                    const cursor = cm.getCursor();
                    if (cursor.line > 0) {
                        const line = cm.getLine(cursor.line);
                        cm.replaceRange("", CodeMirror.Pos(cursor.line, 0), CodeMirror.Pos(cursor.line + 1, 0));
                        cm.replaceRange(line + "\n", CodeMirror.Pos(cursor.line - 1, 0));
                        cm.setCursor(cursor.line - 1, cursor.ch);
                    }
                },
                "Option-Down": function(cm) {
                    const cursor = cm.getCursor();
                    const lineCount = cm.lineCount();
                    if (cursor.line < lineCount - 1) {
                        const line = cm.getLine(cursor.line);
                        cm.replaceRange("", CodeMirror.Pos(cursor.line, 0), CodeMirror.Pos(cursor.line + 1, 0));
                        cm.replaceRange(line + "\n", CodeMirror.Pos(cursor.line + 1, 0));
                        cm.setCursor(cursor.line + 1, cursor.ch);
                    }
                },
                
                // Copy line up/down
                "Shift-Alt-Up": function(cm) {
                    const cursor = cm.getCursor();
                    const line = cm.getLine(cursor.line);
                    cm.replaceRange(line + "\n", CodeMirror.Pos(cursor.line, 0));
                    cm.setCursor(cursor.line + 1, cursor.ch);
                },
                "Shift-Alt-Down": function(cm) {
                    const cursor = cm.getCursor();
                    const line = cm.getLine(cursor.line);
                    cm.replaceRange(line + "\n", CodeMirror.Pos(cursor.line + 1, 0));
                    cm.setCursor(cursor.line + 1, cursor.ch);
                },
                "Shift-Option-Up": function(cm) {
                    const cursor = cm.getCursor();
                    const line = cm.getLine(cursor.line);
                    cm.replaceRange(line + "\n", CodeMirror.Pos(cursor.line, 0));
                    cm.setCursor(cursor.line + 1, cursor.ch);
                },
                "Shift-Option-Down": function(cm) {
                    const cursor = cm.getCursor();
                    const line = cm.getLine(cursor.line);
                    cm.replaceRange(line + "\n", CodeMirror.Pos(cursor.line + 1, 0));
                    cm.setCursor(cursor.line + 1, cursor.ch);
                },
                
                // Select word / Select all occurrences
                "Ctrl-D": function(cm) {
                    const cursor = cm.getCursor();
                    const word = cm.findWordAt(cursor);
                    const text = cm.getRange(word.anchor, word.head);
                    const selections = cm.listSelections();
                    const newSelections = [];
                    
                    // Find all occurrences
                    for (let i = 0; i < cm.lineCount(); i++) {
                        const line = cm.getLine(i);
                        let index = 0;
                        while ((index = line.indexOf(text, index)) !== -1) {
                            const from = CodeMirror.Pos(i, index);
                            const to = CodeMirror.Pos(i, index + text.length);
                            newSelections.push({ anchor: from, head: to });
                            index += text.length;
                        }
                    }
                    
                    if (newSelections.length > 0) {
                        cm.setSelections(newSelections);
                    }
                },
                "Cmd-D": function(cm) {
                    const cursor = cm.getCursor();
                    const word = cm.findWordAt(cursor);
                    const text = cm.getRange(word.anchor, word.head);
                    const newSelections = [];
                    
                    for (let i = 0; i < cm.lineCount(); i++) {
                        const line = cm.getLine(i);
                        let index = 0;
                        while ((index = line.indexOf(text, index)) !== -1) {
                            const from = CodeMirror.Pos(i, index);
                            const to = CodeMirror.Pos(i, index + text.length);
                            newSelections.push({ anchor: from, head: to });
                            index += text.length;
                        }
                    }
                    
                    if (newSelections.length > 0) {
                        cm.setSelections(newSelections);
                    }
                },
                
                // Comment toggle
                "Ctrl-/": function(cm) {
                    const selections = cm.listSelections();
                    const newSelections = [];
                    let allCommented = true;
                    
                    selections.forEach(sel => {
                        for (let i = sel.anchor.line; i <= sel.head.line; i++) {
                            const line = cm.getLine(i);
                            if (!line.trim().startsWith('<!--') && !line.trim().endsWith('-->')) {
                                allCommented = false;
                                break;
                            }
                        }
                    });
                    
                    selections.forEach(sel => {
                        for (let i = sel.anchor.line; i <= sel.head.line; i++) {
                            if (allCommented) {
                                const line = cm.getLine(i);
                                const newLine = line.replace(/^(\s*)<!--\s*/, '$1').replace(/\s*-->$/, '');
                                cm.replaceRange(newLine, CodeMirror.Pos(i, 0), CodeMirror.Pos(i, line.length));
                            } else {
                                const line = cm.getLine(i);
                                cm.replaceRange('<!-- ' + line + ' -->', CodeMirror.Pos(i, 0), CodeMirror.Pos(i, line.length));
                            }
                        }
                    });
                },
                "Cmd-/": function(cm) {
                    const selections = cm.listSelections();
                    let allCommented = true;
                    
                    selections.forEach(sel => {
                        for (let i = sel.anchor.line; i <= sel.head.line; i++) {
                            const line = cm.getLine(i);
                            if (!line.trim().startsWith('<!--') && !line.trim().endsWith('-->')) {
                                allCommented = false;
                                break;
                            }
                        }
                    });
                    
                    selections.forEach(sel => {
                        for (let i = sel.anchor.line; i <= sel.head.line; i++) {
                            if (allCommented) {
                                const line = cm.getLine(i);
                                const newLine = line.replace(/^(\s*)<!--\s*/, '$1').replace(/\s*-->$/, '');
                                cm.replaceRange(newLine, CodeMirror.Pos(i, 0), CodeMirror.Pos(i, line.length));
                            } else {
                                const line = cm.getLine(i);
                                cm.replaceRange('<!-- ' + line + ' -->', CodeMirror.Pos(i, 0), CodeMirror.Pos(i, line.length));
                            }
                        }
                    });
                },
                
                // Indent/Outdent
                "Shift-Tab": "indentLess",
                
                // Markdown formatting shortcuts
                "Ctrl-B": function(cm) {
                    const selection = cm.getSelection();
                    if (selection) {
                        cm.replaceSelection(`**${selection}**`);
                    } else {
                        cm.replaceSelection('****');
                        cm.setCursor(cm.getCursor().line, cm.getCursor().ch - 2);
                    }
                },
                "Ctrl-I": function(cm) {
                    const selection = cm.getSelection();
                    if (selection) {
                        cm.replaceSelection(`*${selection}*`);
                    } else {
                        cm.replaceSelection('**');
                        cm.setCursor(cm.getCursor().line, cm.getCursor().ch - 1);
                    }
                },
                "Ctrl-H": function(cm) {
                    const cursor = cm.getCursor();
                    const line = cm.getLine(cursor.line);
                    let level = 1;
                    if (line.match(/^#+\s/)) {
                        const match = line.match(/^(#+)\s/);
                        level = match[1].length;
                        if (level < 6) level++;
                        else level = 1;
                    }
                    const heading = '#'.repeat(level) + ' ';
                    cm.replaceRange(heading, CodeMirror.Pos(cursor.line, 0), CodeMirror.Pos(cursor.line, line.length));
                    cm.setCursor(cursor.line, heading.length);
                },
                "Ctrl-Q": function(cm) {
                    const selection = cm.getSelection();
                    if (selection) {
                        const lines = selection.split('\n');
                        const quoted = lines.map(l => '> ' + l).join('\n');
                        cm.replaceSelection(quoted);
                    } else {
                        cm.replaceSelection('> ');
                    }
                },
                "Ctrl-K": function(cm) {
                    const selection = cm.getSelection();
                    if (selection) {
                        cm.replaceSelection(`[${selection}](url)`);
                        const cursor = cm.getCursor();
                        cm.setCursor(cursor.line, cursor.ch - 5);
                    } else {
                        cm.replaceSelection('[](url)');
                        const cursor = cm.getCursor();
                        cm.setCursor(cursor.line, cursor.ch - 5);
                    }
                },
                "Ctrl-Alt-I": function(cm) {
                    const selection = cm.getSelection();
                    if (selection) {
                        cm.replaceSelection(`![${selection}](url)`);
                        const cursor = cm.getCursor();
                        cm.setCursor(cursor.line, cursor.ch - 5);
                    } else {
                        cm.replaceSelection('![](url)');
                        const cursor = cm.getCursor();
                        cm.setCursor(cursor.line, cursor.ch - 5);
                    }
                },
                "Ctrl-U": function(cm) {
                    const selection = cm.getSelection();
                    if (selection) {
                        const lines = selection.split('\n');
                        const listed = lines.map(l => '- ' + l).join('\n');
                        cm.replaceSelection(listed);
                    } else {
                        cm.replaceSelection('- ');
                    }
                },
                "Ctrl-O": function(cm) {
                    const selection = cm.getSelection();
                    if (selection) {
                        const lines = selection.split('\n');
                        const listed = lines.map((l, i) => `${i + 1}. ${l}`).join('\n');
                        cm.replaceSelection(listed);
                    } else {
                        cm.replaceSelection('1. ');
                    }
                },
                "Shift-Ctrl-C": function(cm) {
                    const selection = cm.getSelection();
                    if (selection) {
                        const lines = selection.split('\n');
                        const checked = lines.map(l => '- [ ] ' + l).join('\n');
                        cm.replaceSelection(checked);
                    } else {
                        cm.replaceSelection('- [ ] ');
                    }
                },
                
                // Search and navigation
                "Ctrl-F": function(cm) {
                    if (CodeMirror.commands.find) {
                        CodeMirror.commands.find(cm);
                    } else {
                        // Fallback: simple search
                        const query = prompt('Find:');
                        if (query) {
                            const cursor = cm.getSearchCursor(query);
                            if (cursor.findNext()) {
                                cm.setSelection(cursor.from(), cursor.to());
                            }
                        }
                    }
                },
                "Ctrl-G": function(cm) {
                    if (CodeMirror.commands.jumpToLine) {
                        CodeMirror.commands.jumpToLine(cm);
                    } else {
                        const line = prompt('Go to line:');
                        if (line) {
                            const num = parseInt(line) - 1;
                            if (num >= 0 && num < cm.lineCount()) {
                                cm.setCursor(num, 0);
                            }
                        }
                    }
                },
                "Ctrl-Home": function(cm) {
                    cm.setCursor(0, 0);
                },
                "Ctrl-End": function(cm) {
                    const lastLine = cm.lineCount() - 1;
                    cm.setCursor(lastLine, cm.getLine(lastLine).length);
                },
                
                // Autocomplete for containers
                "Ctrl-Space": function(cm) {
                    if (CodeMirror.hint && CodeMirror.hint.container) {
                        CodeMirror.hint.container(cm);
                    }
                }
            }
        });

        // Register container hint
        if (CodeMirror.hint) {
            CodeMirror.hint.container = containerHint;
        }
        
        // Handle cursor positioning after container autocomplete
        codeEditor.on('change', function(cm, change) {
            // Check if change looks like a container insertion
            if (change.text && change.text.length >= 3) {
                const line = change.from.line;
                const lineText = cm.getLine(line);
                const nextLine = cm.getLine(line + 1);
                const thirdLine = cm.getLine(line + 2);
                
                if (lineText && lineText.match(/^:::\s+(info|success|warning|danger|note|tip)$/) &&
                    (nextLine === '' || nextLine === undefined) && 
                    (thirdLine === ':::' || (change.text[2] && change.text[2] === ':::'))) {
                    
                    setTimeout(() => {
                        cm.setCursor(line + 1, 0);
                        cm.focus();
                    }, 20);
                }
            }
        });

        // Handle paste event for images
        codeEditor.on('paste', function(cm, e) {
            const clipboardData = e.clipboardData || window.clipboardData;
            if (!clipboardData) return;
            
            const items = clipboardData.items;
            if (!items) return;
            
            // Check for image in clipboard
            for (let i = 0; i < items.length; i++) {
                if (items[i].type.indexOf('image') !== -1) {
                    e.preventDefault();
                    const file = items[i].getAsFile();
                    
                    // Show uploading status
                    updateSaveStatus('Uploading image...', true);
                    
                    // Convert file to base64
                    const reader = new FileReader();
                    reader.onload = async function(event) {
                        try {
                            const base64Data = event.target.result;
                            
                            // Upload image
                            const response = await fetch('/api/upload-image', {
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json'
                                },
                                body: JSON.stringify({
                                    imageData: base64Data,
                                    contentType: file.type
                                })
                            });
                            
                            if (!response.ok) {
                                const error = await response.json();
                                throw new Error(error.error || 'Failed to upload image');
                            }
                            
                            const data = await response.json();
                            const imageUrl = data.url || `/api/image/${data.path}`;
                            
                            // Insert markdown image syntax at cursor position
                            const cursor = cm.getCursor();
                            const imageMarkdown = `![image](${imageUrl})`;
                            cm.replaceRange(imageMarkdown, cursor);
                            
                            updateSaveStatus('Image uploaded', false);
                            setTimeout(() => {
                                updateSaveStatus('', false);
                            }, 2000);
                        } catch (error) {
                            console.error('Error uploading image:', error);
                            updateSaveStatus('Upload failed', false);
                            alert('Failed to upload image: ' + error.message);
                        }
                    };
                    reader.readAsDataURL(file);
                    return;
                }
            }
        });

        // Add extra space at the end of editor for easier typing
        // This ensures users can scroll down to type comfortably
        const ensureTrailingSpace = function() {
            const content = codeEditor.getValue();
            const lastLine = codeEditor.lastLine();
            const trailingNewlines = (content.match(/\n+$/)) ? content.match(/\n+$/)[0].length : 0;
            // Ensure at least 30 empty lines at the end for comfortable scrolling
            if (trailingNewlines < 30) {
                const linesToAdd = 30 - trailingNewlines;
                const cursor = codeEditor.getCursor();
                codeEditor.setValue(content + '\n'.repeat(linesToAdd));
                codeEditor.setCursor(cursor);
            }
        };
        
        // Ensure trailing space when editor is initialized or content changes
        codeEditor.on('change', ensureTrailingSpace);
        
        // Auto-save on change with debounce
        const debouncedSave = debounce(saveFile, 1000);
        codeEditor.on('change', () => {
            if (isUpdatingFromSocket) return; // Skip if updating from socket
            
            // --- FIX: Đánh dấu đang gõ để chặn scroll sync ---
            isTyping = true;
            if (typingTimeout) clearTimeout(typingTimeout);
            
            // Sau 500ms không gõ gì nữa thì mới cho phép sync lại
            typingTimeout = setTimeout(() => {
                isTyping = false;
            }, 500);
            // --- FIX END ---
            
            const content = codeEditor.getValue();
            updatePreview(content);
            
            if (currentFilePath) {
                debouncedSave();
                
                // Broadcast changes to other clients via socket (realtime sync)
                if (socket) {
                    clearTimeout(socketChangeTimeout);
                    socketChangeTimeout = setTimeout(() => {
                        // Only broadcast if content actually changed
                        if (content !== lastBroadcastedContent) {
                            socket.emit('file:edit', {
                                path: currentFilePath,
                                content: content
                            });
                            lastBroadcastedContent = content;
                        }
                    }, 200); // Debounce 200ms for realtime sync
                }
            }
        });
        
        // Sync scroll between editor and preview (pixel-based algorithm with image handling)
        let isScrollingEditor = false;
        let isScrollingPreview = false;
        
        const previewEl = document.getElementById('preview');
        
        // Build mapping between editor lines and preview pixel positions
        // This handles images correctly by using their actual pixel heights
        function buildLineToPixelMapping() {
            // Return cached mapping if still valid (within 300ms)
            if (lineToPixelMapping && Date.now() - mappingCacheTimestamp < 300) {
                return lineToPixelMapping;
            }
            
            const mapping = [];
            const editorContent = codeEditor.getValue();
            const lines = editorContent.split('\n');
            
            // Get all block elements in preview (including images)
            const elements = previewEl.querySelectorAll('p, h1, h2, h3, h4, h5, h6, img, pre, blockquote, ul, ol, table, .markdown-container, .katex-display');
            
            if (elements.length === 0) {
                lineToPixelMapping = mapping;
                mappingCacheTimestamp = Date.now();
                return mapping;
            }
            
            // Build mapping: for each element, find corresponding line range in editor
            let currentLine = 0;
            
            elements.forEach((element, index) => {
                const offsetTop = element.offsetTop;
                // For images, use actual pixel height (offsetHeight or naturalHeight)
                const offsetHeight = element.tagName === 'IMG' 
                    ? (element.offsetHeight || element.naturalHeight || 0)
                    : (element.offsetHeight || 0);
                const offsetBottom = offsetTop + offsetHeight;
                
                // For images, they usually take 1 line in markdown
                if (element.tagName === 'IMG') {
                    // Find the line containing image markdown
                    let imageLine = -1;
                    for (let i = currentLine; i < lines.length; i++) {
                        if (lines[i].match(/!\[.*\]\(.*\)/)) {
                            imageLine = i;
                            break;
                        }
                    }
                    
                    if (imageLine >= 0) {
                        mapping.push({
                            lineStart: imageLine,
                            lineEnd: imageLine,
                            pixelStart: offsetTop,
                            pixelEnd: offsetBottom,
                            isImage: true,
                            pixelHeight: offsetHeight
                        });
                        currentLine = imageLine + 1;
                    }
                } else {
                    // For text elements, estimate line count based on content
                    const elementText = element.textContent || '';
                    const estimatedLines = Math.max(1, Math.ceil(elementText.length / 80));
                    
                    mapping.push({
                        lineStart: currentLine,
                        lineEnd: currentLine + estimatedLines - 1,
                        pixelStart: offsetTop,
                        pixelEnd: offsetBottom,
                        isImage: false
                    });
                    currentLine += estimatedLines;
                }
            });
            
            // Cache the mapping
            lineToPixelMapping = mapping;
            mappingCacheTimestamp = Date.now();
            
            return mapping;
        }
        
        // Get preview pixel position for editor line (accounting for image pixel heights)
        function getPreviewPixelForLine(editorLine) {
            const mapping = buildLineToPixelMapping(); // Uses cache internally
            
            if (mapping.length === 0) {
                // Fallback to simple ratio
                const scrollInfo = codeEditor.getScrollInfo();
                const maxScroll = scrollInfo.height - scrollInfo.clientHeight;
                const scrollRatio = maxScroll > 0 ? scrollInfo.top / maxScroll : 0;
                const previewMaxScroll = previewEl.scrollHeight - previewEl.clientHeight;
                return previewMaxScroll > 0 ? scrollRatio * previewMaxScroll : 0;
            }
            
            // Find mapping entry that contains this line
            for (const map of mapping) {
                if (editorLine >= map.lineStart && editorLine <= map.lineEnd) {
                    // Interpolate within the range
                    if (map.lineStart === map.lineEnd) {
                        return map.pixelStart;
                    }
                    const lineRatio = (editorLine - map.lineStart) / (map.lineEnd - map.lineStart);
                    return map.pixelStart + lineRatio * (map.pixelEnd - map.pixelStart);
                }
            }
            
            // If line is beyond mapping, use last entry or estimate
            if (mapping.length > 0) {
                const lastMap = mapping[mapping.length - 1];
                if (editorLine > lastMap.lineEnd) {
                    return lastMap.pixelEnd;
                }
            }
            
            // Fallback: estimate based on line ratio
            const editorContent = codeEditor.getValue();
            const totalLines = editorContent.split('\n').length;
            const lineRatio = totalLines > 0 ? editorLine / totalLines : 0;
            return lineRatio * (previewEl.scrollHeight - previewEl.clientHeight);
        }
        
        // Get editor line for preview pixel position
        function getEditorLineForPixel(pixelPos) {
            const mapping = buildLineToPixelMapping(); // Uses cache internally
            
            if (mapping.length === 0) {
                // Fallback to simple ratio
                const previewMaxScroll = previewEl.scrollHeight - previewEl.clientHeight;
                const scrollRatio = previewMaxScroll > 0 ? pixelPos / previewMaxScroll : 0;
                const scrollInfo = codeEditor.getScrollInfo();
                const maxScroll = scrollInfo.height - scrollInfo.clientHeight;
                return maxScroll > 0 ? scrollRatio * maxScroll : 0;
            }
            
            // Find element at this pixel position
            for (const map of mapping) {
                if (pixelPos >= map.pixelStart && pixelPos <= map.pixelEnd) {
                    // Interpolate within the range
                    if (map.lineStart === map.lineEnd) {
                        return map.lineStart;
                    }
                    const pixelRatio = (pixelPos - map.pixelStart) / (map.pixelEnd - map.pixelStart);
                    return map.lineStart + pixelRatio * (map.lineEnd - map.lineStart);
                }
            }
            
            // Find nearest element
            let bestMatch = null;
            let bestDistance = Infinity;
            
            mapping.forEach(map => {
                const distance = Math.min(
                    Math.abs(pixelPos - map.pixelStart),
                    Math.abs(pixelPos - map.pixelEnd)
                );
                if (distance < bestDistance) {
                    bestDistance = distance;
                    bestMatch = map;
                }
            });
            
            if (bestMatch) {
                return bestMatch.lineStart;
            }
            
            // Fallback: estimate based on pixel ratio
            const previewMaxScroll = previewEl.scrollHeight - previewEl.clientHeight;
            const pixelRatio = previewMaxScroll > 0 ? pixelPos / previewMaxScroll : 0;
            const editorContent = codeEditor.getValue();
            const totalLines = editorContent.split('\n').length;
            return Math.floor(pixelRatio * totalLines);
        }
        
        // Sync scroll from editor to preview (pixel-based with image handling)
        codeEditor.on('scroll', function() {
            if (isScrollingPreview) return;
            if (isTyping) return; // Đang gõ thì không sync
            
            isScrollingEditor = true;
            
            const scrollInfo = codeEditor.getScrollInfo();
            
            // Kiểm tra sát đáy Editor - ép Preview xuống đáy
            if (scrollInfo.top + scrollInfo.clientHeight >= scrollInfo.height - 50) {
                previewEl.scrollTop = previewEl.scrollHeight;
                setTimeout(() => { isScrollingEditor = false; }, 50);
                return;
            }
            
            // Get the line number at the top of visible area
            const lineHeight = codeEditor.defaultTextHeight();
            const topLine = Math.floor(scrollInfo.top / lineHeight);
            
            // Get corresponding pixel position in preview (accounts for image pixel heights)
            const previewScrollTop = getPreviewPixelForLine(topLine);
            
            previewEl.scrollTop = previewScrollTop;
            
            setTimeout(() => {
                isScrollingEditor = false;
            }, 50);
        });
        
        // Sync scroll from preview to editor (pixel-based with image handling)
        previewEl.addEventListener('scroll', function() {
            if (isScrollingEditor) return;
            if (isTyping) return; // Đang gõ thì không sync
            
            isScrollingPreview = true;
            
            // Kiểm tra sát đáy Preview - ép Editor xuống đáy
            if (previewEl.scrollTop + previewEl.clientHeight >= previewEl.scrollHeight - 50) {
                const scrollInfo = codeEditor.getScrollInfo();
                codeEditor.scrollTo(null, scrollInfo.height);
                setTimeout(() => { isScrollingPreview = false; }, 50);
                return;
            }
            
            // Get corresponding line in editor based on pixel position
            const editorLine = getEditorLineForPixel(previewEl.scrollTop);
            
            // Convert line to scroll position
            const lineHeight = codeEditor.defaultTextHeight();
            const editorScrollTop = editorLine * lineHeight;
            
            codeEditor.scrollTo(null, editorScrollTop);
            
            setTimeout(() => {
                isScrollingPreview = false;
            }, 50);
        });
        
        // Auto-show hint when typing :::
        codeEditor.on('inputRead', function(cm, change) {
            if (change.text && change.text[0]) {
                const text = change.text[0];
                const cursor = cm.getCursor();
                const line = cm.getLine(cursor.line);
                const beforeCursor = line.substring(0, cursor.ch);
                
                // Show hint when typing ::: at start of line or after ::: with space
                if (text.includes(':') && (beforeCursor.trim() === ':::' || beforeCursor.match(/^:::\s*$/))) {
                    setTimeout(() => {
                        if (CodeMirror.hint && CodeMirror.hint.container) {
                            CodeMirror.showHint(cm, CodeMirror.hint.container, {
                                completeSingle: false,
                                closeOnUnfocus: true,
                                alignWithWord: false
                            });
                        }
                    }, 150);
                }
            }
        });
        
    } else {
        console.error('CodeMirror not loaded');
        // Fallback to textarea if CodeMirror fails
        editorEl.innerHTML = '<textarea id="editor-textarea" placeholder="Select a file from the sidebar or create a new one..."></textarea>';
        const textarea = document.getElementById('editor-textarea');
        const debouncedSave = debounce(saveFile, 1000);
        textarea.addEventListener('input', (e) => {
            updatePreview(e.target.value);
            if (currentFilePath) {
                debouncedSave();
            }
        });
    }
}

// Drag and Drop Handlers
function handleDragStart(e) {
    draggedElement = this;
    this.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', this.dataset.path);
}

function handleDragOver(e) {
    if (e.preventDefault) {
        e.preventDefault();
    }
    
    // Only allow dropping on folders
    if (this.dataset.type === 'folder' && draggedElement && draggedElement !== this) {
        // Check if trying to drop into itself or a child folder
        const draggedPath = draggedElement.dataset.path;
        const targetPath = this.dataset.path;
        
        // Prevent dropping into itself or child folders
        if (targetPath.startsWith(draggedPath + '/') || targetPath === draggedPath) {
            e.dataTransfer.dropEffect = 'none';
            return false;
        }
        
        this.classList.add('drag-over');
        e.dataTransfer.dropEffect = 'move';
        
        // Auto-expand folder after hovering for 1 second
        if (!this.dataset.expandTimer) {
            this.dataset.expandTimer = setTimeout(() => {
                const children = this.querySelector('.folder-children');
                if (children && !children.classList.contains('expanded')) {
                    const item = findItemByPath(fileTreeData, this.dataset.path);
                    if (item) {
                        toggleFolder(this, item);
                    }
                }
                delete this.dataset.expandTimer;
            }, 1000);
        }
    } else {
        e.dataTransfer.dropEffect = 'none';
    }
    
    return false;
}

function handleDrop(e) {
    if (e.stopPropagation) {
        e.stopPropagation();
    }
    
    // Clear expand timer
    if (this.dataset.expandTimer) {
        clearTimeout(this.dataset.expandTimer);
        delete this.dataset.expandTimer;
    }
    
    this.classList.remove('drag-over');
    
    if (draggedElement && this.dataset.type === 'folder' && draggedElement !== this) {
        const fromPath = draggedElement.dataset.path;
        const toFolderPath = this.dataset.path;
        const fileName = draggedElement.dataset.type === 'file' 
            ? draggedElement.querySelector('.file-name').textContent
            : draggedElement.querySelector('.file-name').textContent;
        
        const toPath = toFolderPath + '/' + fileName;
        
        // Move the file/folder
        moveFileOrFolder(fromPath, toPath);
    }
    
    return false;
}

function handleDragEnd(e) {
    this.classList.remove('dragging');
    document.querySelectorAll('.file-item').forEach(el => {
        el.classList.remove('drag-over');
        // Clear any pending expand timers
        if (el.dataset.expandTimer) {
            clearTimeout(el.dataset.expandTimer);
            delete el.dataset.expandTimer;
        }
    });
    draggedElement = null;
}

// Show context menu
function showContextMenu(e, filePath, fileName, fileType) {
    // Remove existing context menu
    const existingMenu = document.getElementById('contextMenu');
    if (existingMenu) {
        existingMenu.remove();
    }
    
    // Create context menu
    const menu = document.createElement('div');
    menu.id = 'contextMenu';
    menu.className = 'context-menu';
    menu.style.left = e.pageX + 'px';
    menu.style.top = e.pageY + 'px';
    menu.style.display = 'block';
    
    // Menu items
    const items = [
        { label: '📋 Copy', action: () => copyFile(filePath, fileName) },
        { label: '✏️ Rename', action: () => renameFile(filePath, fileName) },
        { separator: true },
        { label: '🗑️ Delete', action: () => deleteFile(filePath, fileName, fileType), danger: true }
    ];
    
    items.forEach(item => {
        if (item.separator) {
            const separator = document.createElement('div');
            separator.className = 'context-menu-separator';
            menu.appendChild(separator);
        } else {
            const menuItem = document.createElement('div');
            menuItem.className = 'context-menu-item' + (item.danger ? ' danger' : '');
            menuItem.textContent = item.label;
            menuItem.addEventListener('click', (e) => {
                e.stopPropagation();
                item.action();
                menu.remove();
            });
            menu.appendChild(menuItem);
        }
    });
    
    document.body.appendChild(menu);
    
    // Close menu when clicking outside
    const closeMenu = (e) => {
        if (!menu.contains(e.target)) {
            menu.remove();
            document.removeEventListener('click', closeMenu);
        }
    };
    
    setTimeout(() => {
        document.addEventListener('click', closeMenu);
    }, 100);
}

// Delete file or folder
async function deleteFile(filePath, fileName, fileType) {
    if (!confirm(`Are you sure you want to delete "${fileName}"?\n\nThis action cannot be undone.`)) {
        return;
    }
    
    try {
        updateSaveStatus('Deleting...', true);
        
        const response = await fetch('/api/delete', {
            method: 'DELETE',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                path: filePath
            })
        });
        
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to delete file/folder');
        }
        
        // If deleted file was currently open, clear editor
        if (currentFilePath === filePath) {
            currentFilePath = null;
            updateFileNameDisplay(null);
            if (codeEditor) {
                codeEditor.setValue('');
            }
            updatePreview('');
        }
        
        // Refresh file tree
        await fetchFileTree();
        updateSaveStatus('Deleted', false);
        
        setTimeout(() => {
            updateSaveStatus('', false);
        }, 2000);
    } catch (error) {
        console.error('Error deleting file/folder:', error);
        updateSaveStatus('', false);
        alert('Failed to delete: ' + error.message);
    }
}

// Copy file or folder
async function copyFile(filePath, fileName) {
    try {
        // Get directory and generate copy name
        const dir = pathDirname(filePath);
        const ext = pathExtname(fileName);
        const nameWithoutExt = pathBasename(fileName, ext);
        let copyName = `${nameWithoutExt}-copy${ext}`;
        let copyPath = dir ? `${dir}/${copyName}` : copyName;
        
        // If copy exists, add number
        let counter = 1;
        while (await fileExists(copyPath)) {
            copyName = `${nameWithoutExt}-copy-${counter}${ext}`;
            copyPath = dir ? `${dir}/${copyName}` : copyName;
            counter++;
        }
        
        updateSaveStatus('Copying...', true);
        
        const response = await fetch('/api/copy', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                fromPath: filePath,
                toPath: copyPath
            })
        });
        
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to copy file/folder');
        }
        
        // Refresh file tree
        await fetchFileTree();
        updateSaveStatus('Copied', false);
        
        setTimeout(() => {
            updateSaveStatus('', false);
        }, 2000);
    } catch (error) {
        console.error('Error copying file/folder:', error);
        updateSaveStatus('', false);
        alert('Failed to copy: ' + error.message);
    }
}

// Rename file or folder
async function renameFile(filePath, fileName) {
    const newName = prompt(`Rename "${fileName}":`, fileName);
    if (!newName || newName === fileName) {
        return;
    }
    
    // Validate name
    if (newName.includes('/') || newName.includes('\\') || newName.includes('..')) {
        alert('Invalid file name. Cannot contain /, \\, or ..');
        return;
    }
    
    try {
        updateSaveStatus('Renaming...', true);
        
        const response = await fetch('/api/rename', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                path: filePath,
                newName: newName
            })
        });
        
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to rename file/folder');
        }
        
        const data = await response.json();
        
        // If renamed file was currently open, update current path
        if (currentFilePath === filePath) {
            currentFilePath = data.newPath;
            // Update file name display with new name
            updateFileNameDisplay(data.newPath);
        }
        
        // Refresh file tree
        await fetchFileTree();
        updateSaveStatus('Renamed', false);
        
        setTimeout(() => {
            updateSaveStatus('', false);
        }, 2000);
    } catch (error) {
        console.error('Error renaming file/folder:', error);
        updateSaveStatus('', false);
        alert('Failed to rename: ' + error.message);
    }
}

// Helper function to check if file exists
async function fileExists(filePath) {
    try {
        const response = await fetch(`/api/file?path=${encodeURIComponent(filePath)}`);
        return response.ok;
    } catch {
        return false;
    }
}

// Helper functions for path manipulation (client-side)
function pathDirname(filePath) {
    const lastSlash = filePath.lastIndexOf('/');
    return lastSlash === -1 ? '' : filePath.substring(0, lastSlash);
}

function pathExtname(filePath) {
    const lastDot = filePath.lastIndexOf('.');
    const lastSlash = filePath.lastIndexOf('/');
    if (lastDot === -1 || (lastSlash !== -1 && lastDot < lastSlash)) {
        return '';
    }
    return filePath.substring(lastDot);
}

function pathBasename(filePath, ext = '') {
    const lastSlash = filePath.lastIndexOf('/');
    const name = lastSlash === -1 ? filePath : filePath.substring(lastSlash + 1);
    if (ext && name.endsWith(ext)) {
        return name.substring(0, name.length - ext.length);
    }
    return name;
}

// Move file or folder
async function moveFileOrFolder(fromPath, toPath) {
    try {
        updateSaveStatus('Moving...', true);
        
        const response = await fetch('/api/move', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                fromPath: fromPath,
                toPath: toPath
            })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to move file/folder');
        }

        // If current file was moved, update current path
        if (currentFilePath === fromPath) {
            currentFilePath = toPath;
        }

        // Refresh file tree
        await fetchFileTree();
        updateSaveStatus('Moved', false);
        
        setTimeout(() => {
            updateSaveStatus('', false);
        }, 2000);
    } catch (error) {
        console.error('Error moving file/folder:', error);
        alert('Failed to move: ' + error.message);
        updateSaveStatus('', false);
    }
}

// Initialize Socket.IO connection
function initSocket() {
    if (typeof io === 'undefined') {
        console.warn('Socket.IO not loaded');
        return;
    }
    
    socket = io();
    
    socket.on('connect', () => {
        console.log('📡 Connected to server');
        // Request current file tree
        socket.emit('filetree:request');
    });
    
    socket.on('disconnect', () => {
        console.log('📡 Disconnected from server');
    });
    
    // Listen for file tree updates
    socket.on('filetree:updated', (data) => {
        if (!isUpdatingFromSocket) {
            fileTreeData = data.tree;
            renderFileTree(fileTreeData);
            console.log('📁 File tree updated from server');
        }
    });
    
    // Listen for file content changes (from save)
    socket.on('file:changed', (data) => {
        // Only update if this file is currently open and change is from another client
        if (currentFilePath === data.path && !isUpdatingFromSocket) {
            if (codeEditor && codeEditor.getValue() !== data.content) {
                // Update editor content
                const cursor = codeEditor.getCursor();
                const scrollInfo = codeEditor.getScrollInfo();
                isUpdatingFromSocket = true;
                codeEditor.setValue(data.content);
                codeEditor.setCursor(cursor);
                codeEditor.scrollTo(null, scrollInfo.top);
                updatePreview(data.content);
                lastBroadcastedContent = data.content;
                isUpdatingFromSocket = false;
                console.log('📝 File updated from server:', data.path);
            }
        }
    });
    
    // Listen for realtime file editing (from other clients typing)
    socket.on('file:edit', (data) => {
        // Only update if this file is currently open and change is from another client
        if (currentFilePath === data.path && !isUpdatingFromSocket) {
            if (codeEditor) {
                const currentContent = codeEditor.getValue();
                // Only update if content is different (avoid unnecessary updates)
                if (currentContent !== data.content) {
                    // Preserve cursor position and scroll
                    const cursor = codeEditor.getCursor();
                    const scrollInfo = codeEditor.getScrollInfo();
                    
                    isUpdatingFromSocket = true;
                    codeEditor.setValue(data.content);
                    // Try to restore cursor position if possible
                    const newLineCount = codeEditor.lineCount();
                    if (cursor.line < newLineCount) {
                        codeEditor.setCursor(cursor);
                    } else {
                        // If line doesn't exist anymore, go to end
                        codeEditor.setCursor(newLineCount - 1, 0);
                    }
                    codeEditor.scrollTo(null, scrollInfo.top);
                    updatePreview(data.content);
                    lastBroadcastedContent = data.content;
                    isUpdatingFromSocket = false;
                    console.log('✏️ Realtime update from another client:', data.path);
                }
            }
        }
    });
    
    // Listen for file deletion
    socket.on('file:deleted', (data) => {
        if (currentFilePath === data.path) {
            // Current file was deleted, clear editor
            currentFilePath = null;
            if (codeEditor) {
                codeEditor.setValue('');
            }
            updatePreview('');
            updateFileNameDisplay('');
        }
        // Refresh file tree
        fetchFileTree();
    });
    
    // Listen for file moves/renames
    socket.on('file:moved', (data) => {
        if (currentFilePath === data.fromPath) {
            currentFilePath = data.toPath;
            loadFile(data.toPath);
        }
        fetchFileTree();
    });
    
    socket.on('file:renamed', (data) => {
        if (currentFilePath === data.oldPath) {
            currentFilePath = data.newPath;
            loadFile(data.newPath);
        }
        fetchFileTree();
    });
    
    socket.on('file:copied', (data) => {
        fetchFileTree();
    });
}

// View/Edit Mode Toggle
let isViewMode = false;

function toggleViewMode() {
    isViewMode = true;
    const editorContainer = document.querySelector('.editor-container');
    const viewModeBtn = document.getElementById('viewModeBtn');
    const editModeBtn = document.getElementById('editModeBtn');
    
    editorContainer.classList.add('view-mode');
    viewModeBtn.classList.add('active');
    editModeBtn.classList.remove('active');
}

function toggleEditMode() {
    isViewMode = false;
    const editorContainer = document.querySelector('.editor-container');
    const viewModeBtn = document.getElementById('viewModeBtn');
    const editModeBtn = document.getElementById('editModeBtn');
    
    editorContainer.classList.remove('view-mode');
    viewModeBtn.classList.remove('active');
    editModeBtn.classList.add('active');
}

// Export functions
async function exportAsPDF() {
    if (!currentFilePath) {
        alert('Please open a file first');
        return;
    }
    
    try {
        const content = codeEditor ? codeEditor.getValue() : '';
        if (!content) {
            alert('File is empty');
            return;
        }
        
        // Get rendered HTML (same as preview)
        let processedContent = preprocessMathBrackets(content);
        processedContent = preprocessContainers(processedContent);
        const html = md.render(processedContent);
        
        // Get preview element's HTML which already has math rendered
        const previewEl = document.getElementById('preview');
        const previewHTML = previewEl.innerHTML;
        
        // Create a new window for printing
        const printWindow = window.open('', '_blank');
        const fileName = escapeHtml(currentFilePath.split('/').pop() || 'document');
        
        printWindow.document.write(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>${fileName}</title>
                <meta charset="UTF-8">
                <style>
                    body {
                        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
                        max-width: 800px;
                        margin: 0 auto;
                        padding: 20px;
                        line-height: 1.6;
                        color: #333;
                    }
                    h1, h2, h3, h4, h5, h6 {
                        margin-top: 24px;
                        margin-bottom: 16px;
                        font-weight: 600;
                        line-height: 1.25;
                    }
                    h1 { font-size: 2em; border-bottom: 1px solid #eaecef; padding-bottom: 0.3em; }
                    h2 { font-size: 1.5em; border-bottom: 1px solid #eaecef; padding-bottom: 0.3em; }
                    p { margin-bottom: 16px; }
                    ul, ol { margin-bottom: 16px; padding-left: 2em; }
                    code { background-color: rgba(27, 31, 35, 0.05); border-radius: 3px; padding: 0.2em 0.4em; font-size: 85%; }
                    pre { background-color: #f6f8fa; border-radius: 6px; padding: 16px; margin-bottom: 16px; overflow: auto; }
                    pre code { background-color: transparent; padding: 0; }
                    blockquote { border-left: 4px solid #dfe2e5; color: #6a737d; padding: 0 1em; margin: 0 0 16px 0; }
                    table { border-collapse: collapse; margin-bottom: 16px; width: 100%; }
                    table th, table td { border: 1px solid #dfe2e5; padding: 6px 13px; }
                    table th { background-color: #f6f8fa; font-weight: 600; }
                    img { max-width: 100%; height: auto; }
                    .markdown-container { margin: 16px 0; padding: 16px; border-left: 4px solid #ccc; border-radius: 4px; background-color: #f6f8fa; }
                    .markdown-container-info { border-left-color: #2196F3; background-color: #e3f2fd; }
                    .markdown-container-success { border-left-color: #4caf50; background-color: #e8f5e9; }
                    .markdown-container-warning { border-left-color: #ff9800; background-color: #fff3e0; }
                    .markdown-container-danger { border-left-color: #f44336; background-color: #ffebee; }
                    .markdown-container-note { border-left-color: #9c27b0; background-color: #f3e5f5; }
                    .markdown-container-tip { border-left-color: #00bcd4; background-color: #e0f7fa; }
                    .katex { font-size: 1.1em; }
                    .katex-display { overflow-x: auto; overflow-y: hidden; padding: 1em 0; margin: 1em 0; }
                    @media print {
                        body { padding: 0; }
                        @page { margin: 1cm; }
                    }
                </style>
                <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">
            </head>
            <body>
                ${previewHTML}
                <script>
                    // Trigger print dialog after page loads
                    window.onload = function() {
                        setTimeout(() => {
                            window.print();
                        }, 500);
                    };
                </script>
            </body>
            </html>
        `);
        printWindow.document.close();
    } catch (error) {
        console.error('Error exporting PDF:', error);
        alert('Failed to export PDF: ' + error.message);
    }
}

async function exportAsMD() {
    if (!currentFilePath) {
        alert('Please open a file first');
        return;
    }
    
    try {
        const content = codeEditor ? codeEditor.getValue() : '';
        if (!content) {
            alert('File is empty');
            return;
        }
        
        // Get filename
        const fileName = currentFilePath.split('/').pop() || 'export.md';
        
        // Create blob and download
        const blob = new Blob([content], { type: 'text/markdown' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    } catch (error) {
        console.error('Error exporting MD:', error);
        alert('Failed to export Markdown: ' + error.message);
    }
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
    initMarkdown();
    initCodeEditor();
    initSocket(); // Initialize Socket.IO
    fetchFileTree();

    const newFileBtn = document.getElementById('newFileBtn');
    const newFolderBtn = document.getElementById('newFolderBtn');
    const viewModeBtn = document.getElementById('viewModeBtn');
    const editModeBtn = document.getElementById('editModeBtn');
    const exportPdfBtn = document.getElementById('exportPdfBtn');
    const exportMdBtn = document.getElementById('exportMdBtn');

    // New file button
    newFileBtn.addEventListener('click', createNewFile);

    // New folder button
    newFolderBtn.addEventListener('click', createNewFolder);
    
    // View/Edit mode toggle
    viewModeBtn.addEventListener('click', toggleViewMode);
    editModeBtn.addEventListener('click', toggleEditMode);
    
    // Export buttons
    exportPdfBtn.addEventListener('click', exportAsPDF);
    exportMdBtn.addEventListener('click', exportAsMD);

    // Initial preview message
    updatePreview('');
    
    // Initialize file name display (empty at start)
    updateFileNameDisplay(null);
});

