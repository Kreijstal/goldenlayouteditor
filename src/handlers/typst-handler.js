// --- Typst Integration Handler ---

// Typst Integration Variables
let typstModule, typstCompiler, typstRenderer;
let isTypstInitializing = false;

/**
 * Determines if this handler can preview a given file.
 * @param {string} fileName - The name of the file.
 * @returns {boolean} - True if the handler can preview the file.
 */
function canHandle(fileName) {
    const extension = fileName.split('.').pop().toLowerCase();
    return extension === 'typ';
}

/**
 * Lazily loads and initializes the Typst library from a CDN.
 * Ensures that the initialization only happens once.
 * @returns {Promise<boolean>} - True if initialization is successful, false otherwise.
 */
async function ensureTypstInitialized() {
    // If it's already initialized, we're done.
    if (typstCompiler) {
        return true;
    }

    // If it's currently initializing in another async call, wait for it to finish.
    if (isTypstInitializing) {
        // A simple polling mechanism to wait for the other process to finish
        return new Promise(resolve => {
            const interval = setInterval(() => {
                if (typstCompiler) {
                    clearInterval(interval);
                    resolve(true);
                } else if (!isTypstInitializing) {
                    // It failed elsewhere
                    clearInterval(interval);
                    resolve(false);
                }
            }, 100);
        });
    }

    isTypstInitializing = true;
    console.log('Initializing Typst.ts (lazy-loaded)...');

    try {
    // Dynamically import the library from esm.sh
    typstModule = await import("https://esm.sh/@myriaddreamin/typst.ts@0.6.1-rc1");
    
    // Create compiler, renderer, and package management components
    typstCompiler = typstModule.createTypstCompiler();
    typstRenderer = typstModule.createTypstRenderer();
    
    // Create access model and package registry for package management
    const accessModel = new typstModule.MemoryAccessModel();
    const packageRegistry = new typstModule.FetchPackageRegistry(accessModel);

    await Promise.all([
      typstCompiler.init({
        getModule: () => "https://cdn.jsdelivr.net/npm/@myriaddreamin/typst-ts-web-compiler@0.6.1-rc1/pkg/typst_ts_web_compiler_bg.wasm",
        beforeBuild: [
          typstModule.withAccessModel(accessModel),
          typstModule.withPackageRegistry(packageRegistry),
          typstModule.preloadRemoteFonts([
            'https://raw.githubusercontent.com/Myriad-Dreamin/typst.ts/main/assets/data/LibertinusSerif-Regular-subset.otf',
          ]),
        ]
      }),
      typstRenderer.init({
        getModule: () => 'https://cdn.jsdelivr.net/npm/@myriaddreamin/typst-ts-renderer@0.6.1-rc1/pkg/typst_ts_renderer_bg.wasm',
      })
    ]);

    console.log('Typst.ts Initialized successfully with package support.');
    isTypstInitializing = false;
    return true;

    } catch(err) {
    console.error("Failed to initialize Typst.ts", err);
    isTypstInitializing = false;
    return false;
    }
}

/**
 * Renders a Typst file to SVG
 * @param {string} mainFileId - The ID of the main Typst file
 * @param {HTMLElement} outputContainer - Container to display the rendered output
 * @param {HTMLElement} diagnosticsContainer - Container to display diagnostics
 * @param {object} projectFiles - All project files for dependencies
 * @param {boolean} preserveZoom - Whether to preserve existing zoom level
 * @param {object} previewComponentInstance - Preview component instance for zoom control
 */
async function renderTypst(mainFileId, outputContainer, diagnosticsContainer, projectFiles, preserveZoom = false, previewComponentInstance = null) {
    const mainFile = projectFiles[mainFileId];
    diagnosticsContainer.textContent = 'Compiling...';

    // Add all project files to the compiler's virtual file system for dependencies
    // Typst can import JSON, text, SVG, and other file types
    Object.values(projectFiles).forEach(file => {
        const filePath = `/${file.name}`;
        typstCompiler.addSource(filePath, file.content);
    });
    
    // Use the actual filename from the selected file as main
    const mainFilePath = `/${mainFile.name}`;

    try {
        const artifact = await typstCompiler.compile({
          mainFilePath: mainFilePath,
        });

        diagnosticsContainer.textContent = 'No errors or warnings.'; // Simplified for demo

        if (artifact && artifact.result) {
          const svg = await typstRenderer.renderSvg({
            artifactContent: artifact.result,
          });
          
          // Preserve existing zoom state if available
          let existingZoomLevel = null;
          let existingTextAlign = null;
          const existingSvg = outputContainer.querySelector('svg');
          if (preserveZoom && existingSvg && previewComponentInstance) {
            existingZoomLevel = previewComponentInstance.zoomLevel;
            existingTextAlign = outputContainer.style.textAlign;
          }
          
          outputContainer.innerHTML = svg;
          
          // Set up the SVG for proper scaling
          const svgElement = outputContainer.querySelector('svg');
          if (svgElement) {
            // Make SVG responsive and set initial size
            svgElement.style.maxWidth = '100%';
            svgElement.style.height = 'auto';
            svgElement.style.display = 'block';
            svgElement.style.margin = '0 auto';
            
            // Apply zoom logic if preview component exists
            if (previewComponentInstance) {
              if (preserveZoom && existingZoomLevel) {
                // Immediately apply preserved zoom to avoid flicker
                svgElement.style.transform = `scale(${existingZoomLevel})`;
                svgElement.style.transformOrigin = 'top center';
                outputContainer.style.textAlign = existingTextAlign || (existingZoomLevel === 1.0 ? 'center' : 'left');
                previewComponentInstance.updateZoomDisplay();
              } else {
                // Use hardcoded 228% zoom for initial render
                previewComponentInstance.zoomLevel = 2.28;
                svgElement.style.transform = `scale(${previewComponentInstance.zoomLevel})`;
                svgElement.style.transformOrigin = 'top center';
                outputContainer.style.textAlign = 'left';
                previewComponentInstance.updateZoomDisplay();
              }
            }
          }
        } else {
          outputContainer.innerHTML = '<p style="color: red;">Compilation failed.</p>';
        }
    } catch (err) {
        console.error("Typst Compilation/Rendering failed:", err);
        diagnosticsContainer.textContent = `CRITICAL ERROR: ${err.message}`;
    }
}

/**
 * Generates the preview content for a Typst file.
 * For Typst files, we return a special object indicating custom rendering is needed.
 * @param {string} fileName - The name of the file.
 * @param {string} fileContent - The content of the file.
 * @returns {object} - An object indicating Typst rendering is required.
 */
function generatePreview(fileName, fileContent) {
    return {
        type: 'typst',
        requiresCustomRender: true
    };
}

/**
 * Renders a Typst file using the custom rendering logic.
 * @param {string} fileId - The ID of the file to render.
 * @param {HTMLElement} outputContainer - Container to display the rendered output.
 * @param {HTMLElement} diagnosticsContainer - Container to display diagnostics.
 * @param {object} projectFiles - All project files for dependencies.
 * @param {boolean} preserveZoom - Whether to preserve existing zoom level.
 * @param {object} previewComponentInstance - Preview component instance for zoom control.
 */
async function render(fileId, outputContainer, diagnosticsContainer, projectFiles, preserveZoom = false, previewComponentInstance = null) {
    // First, ensure the library is loaded and ready
    const success = await ensureTypstInitialized();

    if (success) {
        // Now that we know it's ready, call the render function
        await renderTypst(fileId, outputContainer, diagnosticsContainer, projectFiles, preserveZoom, previewComponentInstance);
    } else {
        diagnosticsContainer.textContent = 'Error: Typst compiler failed to load.';
    }
}

/**
 * Gets the file type for Typst files (used for editor mode).
 * @param {string} fileName - The name of the file.
 * @returns {string} - The file type for editor configuration.
 */
function getFileType(fileName) {
    return 'typst';
}

/**
 * Creates the custom UI for the Typst preview.
 * @param {HTMLElement} container - The container to build the UI in.
 * @param {object} previewComponentInstance - The instance of the preview component.
 * @returns {object} - An object containing references to the created UI elements.
 */
function createPreviewUI(container, previewComponentInstance) {
    // Add Typst-specific controls
    const typstControlsDiv = document.createElement('div');
    typstControlsDiv.style.padding = '5px 10px';
    typstControlsDiv.style.borderBottom = '1px solid #ddd';
    typstControlsDiv.style.background = '#fafafa';
    typstControlsDiv.style.display = 'flex';
    typstControlsDiv.style.alignItems = 'center';
    typstControlsDiv.style.gap = '10px';
    typstControlsDiv.style.fontSize = '14px';
    
    // Zoom controls
    const zoomLabel = document.createElement('span');
    zoomLabel.textContent = 'Zoom:';
    zoomLabel.style.fontWeight = 'bold';
    
    const zoomOutBtn = document.createElement('button');
    zoomOutBtn.textContent = '−';
    zoomOutBtn.style.padding = '2px 8px';
    zoomOutBtn.style.border = '1px solid #ccc';
    zoomOutBtn.style.background = 'white';
    zoomOutBtn.style.cursor = 'pointer';
    zoomOutBtn.style.borderRadius = '3px';
    
    const zoomDisplay = document.createElement('span');
    zoomDisplay.textContent = '100%';
    zoomDisplay.style.minWidth = '50px';
    zoomDisplay.style.textAlign = 'center';
    zoomDisplay.style.fontFamily = 'monospace';
    
    const zoomInBtn = document.createElement('button');
    zoomInBtn.textContent = '+';
    zoomInBtn.style.padding = '2px 8px';
    zoomInBtn.style.border = '1px solid #ccc';
    zoomInBtn.style.background = 'white';
    zoomInBtn.style.cursor = 'pointer';
    zoomInBtn.style.borderRadius = '3px';
    
    const fitWidthBtn = document.createElement('button');
    fitWidthBtn.textContent = 'Fit Width';
    fitWidthBtn.style.padding = '2px 8px';
    fitWidthBtn.style.border = '1px solid #ccc';
    fitWidthBtn.style.background = 'white';
    fitWidthBtn.style.cursor = 'pointer';
    fitWidthBtn.style.borderRadius = '3px';
    fitWidthBtn.style.marginLeft = '10px';
    
    // Add zoom event listeners
    zoomOutBtn.onclick = () => previewComponentInstance.adjustZoom(0.9);
    zoomInBtn.onclick = () => previewComponentInstance.adjustZoom(1.1);
    fitWidthBtn.onclick = () => previewComponentInstance.fitToWidth();
    
    typstControlsDiv.appendChild(zoomLabel);
    typstControlsDiv.appendChild(zoomOutBtn);
    typstControlsDiv.appendChild(zoomDisplay);
    typstControlsDiv.appendChild(zoomInBtn);
    typstControlsDiv.appendChild(fitWidthBtn);
    container.appendChild(typstControlsDiv);
    
    const outputDiv = document.createElement('div');
    outputDiv.style.flex = '1';
    outputDiv.style.padding = '1rem';
    outputDiv.style.overflow = 'auto'; // Enable scrollbars for pan
    outputDiv.style.background = 'white';
    outputDiv.style.textAlign = 'left'; // Left-aligned for fit-width default
    
    const diagnosticsDiv = document.createElement('div');
    diagnosticsDiv.style.height = '100px';
    diagnosticsDiv.style.backgroundColor = '#212529';
    diagnosticsDiv.style.color = '#f8f9fa';
    diagnosticsDiv.style.fontFamily = 'monospace';
    diagnosticsDiv.style.whiteSpace = 'pre-wrap';
    diagnosticsDiv.style.padding = '1rem';
    diagnosticsDiv.style.overflowY = 'auto';
    
    container.appendChild(outputDiv);
    container.appendChild(diagnosticsDiv);

    // Pass back references to the elements the handler needs to control
    return { outputDiv, diagnosticsDiv, zoomDisplay };
}

/**
 * Initializes a custom Ace mode for Typst syntax highlighting.
 * This dynamically loads the custom mode at runtime.
 */
function initializeAceMode() {
    if (typeof window === 'undefined' || typeof window.ace === 'undefined') {
        console.warn('[TypstHandler] Ace editor not available, skipping mode initialization');
        return;
    }

    // Dynamically load the custom Typst mode
    const script = document.createElement('script');
    script.src = './ace-modes/typst.js';
    script.onload = () => {
        console.log('[TypstHandler] Custom Typst Ace mode loaded successfully');
    };
    script.onerror = () => {
        console.error('[TypstHandler] Failed to load custom Typst Ace mode');
    };
    document.head.appendChild(script);
}

/**
 * Gets the Ace editor mode for Typst files.
 * @param {string} fileName - The name of the file.
 * @returns {string} - The Ace editor mode.
 */
function getAceMode(fileName) {
    // Return our custom Typst mode name
    // The mode will be loaded dynamically when needed
    return 'typst';
}

module.exports = {
    canHandle,
    generatePreview,
    render,
    getFileType,
    createPreviewUI,
    getAceMode,
    initializeAceMode
};
