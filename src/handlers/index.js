// --- Handler Registry ---
// Central registry for all file type handlers

const webHandler = require('./web-handler');
const typstHandler = require('./typst-handler');

// Registry of all available handlers
const handlers = [
    webHandler,
    typstHandler
];

/**
 * Gets the appropriate handler for a given file.
 * @param {string} fileName - The name of the file.
 * @returns {object|null} - The handler object or null if no handler is found.
 */
function getHandlerForFile(fileName) {
    for (const handler of handlers) {
        if (handler.canHandle(fileName)) {
            return handler;
        }
    }
    
    // Return web handler as default fallback (includes default preview)
    return webHandler;
}

/**
 * Generates preview content for a file using the appropriate handler.
 * @param {string} fileName - The name of the file.
 * @param {string} fileContent - The content of the file.
 * @param {string} fileType - The type of the file (optional, for compatibility).
 * @returns {object} - The preview content object.
 */
function generatePreviewContent(fileName, fileContent, fileType) {
    const handler = getHandlerForFile(fileName);
    return handler.generatePreview(fileName, fileContent);
}

/**
 * Checks if a file requires custom rendering (like Typst).
 * @param {string} fileName - The name of the file.
 * @returns {boolean} - True if the file requires custom rendering.
 */
function requiresCustomRender(fileName) {
    const handler = getHandlerForFile(fileName);
    const preview = handler.generatePreview(fileName, '');
    return preview.requiresCustomRender === true;
}

/**
 * Renders a file using custom rendering logic if available.
 * @param {string} fileName - The name of the file.
 * @param {string} fileId - The ID of the file.
 * @param {HTMLElement} outputContainer - Container to display the rendered output.
 * @param {HTMLElement} diagnosticsContainer - Container to display diagnostics.
 * @param {object} projectFiles - All project files for dependencies.
 * @param {boolean} preserveZoom - Whether to preserve existing zoom level.
 * @param {object} previewComponentInstance - Preview component instance.
 */
async function renderFile(fileName, fileId, outputContainer, diagnosticsContainer, projectFiles, preserveZoom = false, previewComponentInstance = null) {
    const handler = getHandlerForFile(fileName);
    
    if (handler.render && typeof handler.render === 'function') {
        await handler.render(fileId, outputContainer, diagnosticsContainer, projectFiles, preserveZoom, previewComponentInstance);
    } else {
        throw new Error(`Handler for ${fileName} does not support custom rendering`);
    }
}

/**
 * Gets the file type for a given file name by asking handlers.
 * @param {string} fileName - The name of the file.
 * @returns {string} - The file type or 'text' as default.
 */
function getFileType(fileName) {
    for (const handler of handlers) {
        if (handler.getFileType && handler.canHandle(fileName)) {
            return handler.getFileType(fileName);
        }
    }
    
    // Default fallback for common web files
    const extension = fileName.split('.').pop().toLowerCase();
    switch (extension) {
        case 'html':
        case 'htm':
            return 'html';
        case 'css':
            return 'css';
        case 'js':
        case 'javascript':
            return 'javascript';
        case 'json':
            return 'json';
        default:
            return 'text';
    }
}

/**
 * Gets all registered handlers (useful for debugging or extension).
 * @returns {array} - Array of all registered handlers.
 */
function getAllHandlers() {
    return [...handlers];
}

/**
 * Creates the custom UI for a file preview, if the handler supports it.
 * @param {string} fileName - The name of the file.
 * @param {HTMLElement} container - The container to build the UI in.
 * @param {object} previewComponentInstance - The instance of the preview component.
 */
function createPreviewUI(fileName, container, previewComponentInstance) {
    const handler = getHandlerForFile(fileName);
    if (handler && typeof handler.createPreviewUI === 'function') {
        return handler.createPreviewUI(container, previewComponentInstance);
    }
    // Return a default structure if no custom UI is provided
    const outputDiv = document.createElement('div');
    container.appendChild(outputDiv);
    return { outputDiv, diagnosticsDiv: null };
}

/**
 * Initializes custom Ace modes for all handlers that support it.
 * Should be called once at application startup.
 */
function initializeAllAceModes() {
    handlers.forEach(handler => {
        if (handler && typeof handler.initializeAceMode === 'function') {
            try {
                handler.initializeAceMode();
                console.log(`[HandlerRegistry] Initialized Ace mode for handler: ${handler.constructor?.name || 'unknown'}`);
            } catch (error) {
                console.error(`[HandlerRegistry] Failed to initialize Ace mode for handler:`, error);
            }
        }
    });
}

/**
 * Gets the Ace editor mode for a given file name by asking handlers.
 * @param {string} fileName - The name of the file.
 * @returns {string} - The Ace mode or 'text' as default.
 */
function getAceModeForFile(fileName) {
    const handler = getHandlerForFile(fileName);
    if (handler && typeof handler.getAceMode === 'function') {
        // Ensure the handler's Ace mode is initialized if it hasn't been already
        if (typeof handler.initializeAceMode === 'function' && !handler._aceModeInitialized) {
            try {
                handler.initializeAceMode();
                handler._aceModeInitialized = true;
                console.log(`[HandlerRegistry] Lazily initialized Ace mode for handler`);
            } catch (error) {
                console.error(`[HandlerRegistry] Failed to lazily initialize Ace mode:`, error);
            }
        }
        return handler.getAceMode(fileName);
    }
    return 'text'; // Default fallback
}

module.exports = {
    getHandlerForFile,
    generatePreviewContent,
    requiresCustomRender,
    renderFile,
    getFileType,
    createPreviewUI,
    getAceModeForFile,
    initializeAllAceModes,
    getAllHandlers
};