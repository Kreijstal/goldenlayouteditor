// --- Typst Integration Handler ---

const TYPST_VERSION = '0.6.1-rc5';
const TYPST_PAGE_GAP = 10;

// Typst Integration Variables
let typstModule, typstCompiler, typstRenderer;
let typstInitializationPromise = null;

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
  if (typstCompiler && typstRenderer) {
    return true;
  }

  // If it's currently initializing in another async call, wait for it to finish.
  if (typstInitializationPromise) {
    return typstInitializationPromise;
  }

  console.log('Initializing Typst.ts (lazy-loaded)...');

  typstInitializationPromise = (async () => {
    // Dynamically import the library from esm.sh
    const module = await import(`https://esm.sh/@myriaddreamin/typst.ts@${TYPST_VERSION}`);

    // Create compiler, renderer, and package management components
    const compiler = module.createTypstCompiler();
    const renderer = module.createTypstRenderer();

    // Create access model and package registry for package management
    const accessModel = new module.MemoryAccessModel();
    const packageRegistry = new module.FetchPackageRegistry(accessModel);

    await Promise.all([
      compiler.init({
        getModule: () => `https://cdn.jsdelivr.net/npm/@myriaddreamin/typst-ts-web-compiler@${TYPST_VERSION}/pkg/typst_ts_web_compiler_bg.wasm`,
        beforeBuild: [
          module.initOptions.withAccessModel(accessModel),
          module.initOptions.withPackageRegistry(packageRegistry),
          module.initOptions.preloadRemoteFonts([
            'https://raw.githubusercontent.com/Myriad-Dreamin/typst.ts/main/assets/data/LibertinusSerif-Regular-subset.otf',
          ]),
        ]
      }),
      renderer.init({
        getModule: () => `https://cdn.jsdelivr.net/npm/@myriaddreamin/typst-ts-renderer@${TYPST_VERSION}/pkg/typst_ts_renderer_bg.wasm`,
      })
    ]);

    typstModule = module;
    typstCompiler = compiler;
    typstRenderer = renderer;

    console.log('Typst.ts Initialized successfully with package support.');
    return true;
  })();

  try {
    return await typstInitializationPromise;
  } catch (err) {
    console.error("Failed to initialize Typst.ts", err);
    typstInitializationPromise = null;
    typstModule = null;
    typstCompiler = null;
    typstRenderer = null;
    return false;
  }
}

async function renderArtifactAsSvgPages(artifactContent, outputContainer) {
  const svg = await typstRenderer.renderSvg({ artifactContent });
  outputContainer.innerHTML = svg;

  const sourceSvg = outputContainer.querySelector('svg');
  const pageGroups = sourceSvg
    ? Array.from(sourceSvg.children).filter(child =>
      child.tagName.toLowerCase() === 'g' && child.classList.contains('typst-page')
    )
    : [];
  if (!sourceSvg || sourceSvg.nodeName.toLowerCase() !== 'svg' || pageGroups.length === 0) {
    return false;
  }

  const pageWidth = parseFloat(pageGroups[0].getAttribute('data-page-width')) || parseFloat(sourceSvg.getAttribute('width'));
  const pageHeight = parseFloat(pageGroups[0].getAttribute('data-page-height')) || parseFloat(sourceSvg.getAttribute('height'));
  if (!pageWidth || !pageHeight) {
    return false;
  }

  sourceSvg.classList.add('typst-document-svg');
  sourceSvg.dataset.typstPageWidth = String(pageWidth);
  sourceSvg.dataset.typstPageHeight = String(pageHeight);
  sourceSvg.style.display = 'block';
  sourceSvg.style.background = 'transparent';
  sourceSvg.style.boxShadow = 'none';
  sourceSvg.style.margin = '0 auto';

  const sourceWidth = parseFloat(sourceSvg.getAttribute('data-width')) || parseFloat(sourceSvg.getAttribute('width')) || pageWidth;
  const sourceHeight = parseFloat(sourceSvg.getAttribute('data-height')) || parseFloat(sourceSvg.getAttribute('height')) || (pageHeight * pageGroups.length);
  const displayHeight = sourceHeight + TYPST_PAGE_GAP * (pageGroups.length - 1);
  const viewBoxParts = (sourceSvg.getAttribute('viewBox') || `0 0 ${sourceWidth} ${sourceHeight}`).split(/[\s,]+/).map(Number);
  if (viewBoxParts.length >= 4 && viewBoxParts.every(Number.isFinite)) {
    viewBoxParts[3] = displayHeight;
    sourceSvg.setAttribute('viewBox', viewBoxParts.join(' '));
  }
  sourceSvg.setAttribute('height', String(displayHeight));
  sourceSvg.setAttribute('data-height', String(displayHeight));

  pageGroups.forEach((pageGroup, pageIndex) => {
    const transform = pageGroup.getAttribute('transform') || '';
    const translateMatch = transform.match(/translate\(\s*([^) ,]+)(?:[,\s]+([^)]+))?\)/);
    const x = translateMatch ? parseFloat(translateMatch[1]) || 0 : 0;
    const y = translateMatch ? parseFloat(translateMatch[2]) || 0 : pageIndex * pageHeight;
    pageGroup.setAttribute('transform', `translate(${x}, ${y + pageIndex * TYPST_PAGE_GAP})`);

    const pageRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    pageRect.setAttribute('x', '0');
    pageRect.setAttribute('y', '0');
    pageRect.setAttribute('width', pageGroup.getAttribute('data-page-width') || String(pageWidth));
    pageRect.setAttribute('height', pageGroup.getAttribute('data-page-height') || String(pageHeight));
    pageRect.setAttribute('fill', 'white');
    pageRect.setAttribute('stroke', '#d0d4da');
    pageRect.setAttribute('stroke-width', '1');
    pageGroup.insertBefore(pageRect, pageGroup.firstChild);
  });

  return true;
}

/**
 * Renders a Typst file to the preview.
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
  diagnosticsContainer.style.color = '#f8f9fa'; // Reset to default color

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

    // **FIX START**: Always process diagnostics, whether it's a success or failure.
    if (artifact.diagnostics && artifact.diagnostics.length > 0) {
      // Format diagnostics for readability
      const formattedDiagnostics = artifact.diagnostics.map(d =>
        `[${d.severity.toUpperCase()}] at ${d.path.replace(/^\//, '')} (range ${d.range}):\n  ${d.message}`
      ).join('\n\n'); // Use double newline for better separation

      diagnosticsContainer.textContent = formattedDiagnostics;
      diagnosticsContainer.style.display = 'block';

      // Add visual hint for errors
      const hasErrors = artifact.diagnostics.some(d => d.severity === 'error');
      diagnosticsContainer.style.color = hasErrors ? '#ff9e9e' : '#f8f9fa';
    } else {
      diagnosticsContainer.textContent = '';
      diagnosticsContainer.style.display = 'none';
    }
    // **FIX END**

    if (artifact && artifact.result) {
      // Preserve existing zoom state if available
      let existingZoomLevel = null;
      const existingPreview = outputContainer.querySelector('svg');
      if (preserveZoom && existingPreview && previewComponentInstance) {
        existingZoomLevel = previewComponentInstance.zoomLevel;
      }

      let renderedPages = false;
      try {
        renderedPages = await renderArtifactAsSvgPages(artifact.result, outputContainer);
      } catch (pageRenderError) {
        console.warn('Typst per-page render failed, falling back to SVG:', pageRenderError);
      }

      if (!renderedPages) {
        const svg = await typstRenderer.renderSvg({
          artifactContent: artifact.result,
        });
        outputContainer.innerHTML = svg;

        const svgElement = outputContainer.querySelector('svg');
        if (svgElement) {
          svgElement.style.background = 'white';
          svgElement.style.boxShadow = '0 2px 12px rgba(0, 0, 0, 0.18)';
          svgElement.style.margin = '0 auto 24px';
        }
      }

      outputContainer.querySelectorAll('svg').forEach(svgElement => {
        svgElement.style.display = 'block';
      });

      if (previewComponentInstance) {
        if (preserveZoom && existingZoomLevel) {
          previewComponentInstance.updateZoomDisplay();
        } else {
          previewComponentInstance.fitToWidth();
        }
        previewComponentInstance.applyZoom();
      }
    } else {
      // FAILURE PATH: Compilation failed. The diagnostics are already displayed.
      // Update the output pane with a helpful message.
      outputContainer.innerHTML = `<div style="color: #ccc; text-align: center; padding: 40px; font-family: sans-serif;">
          <h2>Compilation Failed</h2>
          <p>See diagnostics in the panel below for details.</p>
      </div>`;
    }
  } catch (err) {
    console.error("Typst Compilation/Rendering failed:", err);
    diagnosticsContainer.textContent = `CRITICAL ERROR: ${err.message}`;
    diagnosticsContainer.style.color = '#ff6b6b';
    diagnosticsContainer.style.display = 'block';
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
    requiresCustomRender: true,
    previewLabel: 'Typst',
    previewColor: '#239dad'
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
  outputDiv.style.overflow = 'auto';
  outputDiv.style.background = '#e9ecef';
  outputDiv.style.padding = '24px';
  outputDiv.style.boxSizing = 'border-box';
  outputDiv.style.textAlign = 'center';

  const diagnosticsDiv = document.createElement('div');
  diagnosticsDiv.style.display = 'none';
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
 * Registers the mode URL with Ace's config so Ace can load it on demand.
 */
let aceModeLoaded = false;

function initializeAceMode() {
  if (typeof window === 'undefined' || typeof window.ace === 'undefined') {
    console.warn('[TypstHandler] Ace editor not available, skipping mode initialization');
    return;
  }

  // Check if mode is already loaded
  if (aceModeLoaded) {
    return;
  }

  // Register the custom mode URL with Ace config.
  // This tells Ace where to find the mode when setMode('ace/mode/typst') is called.
  // Ace will dynamically load it via its own loader, avoiding race conditions.
  const modePath = window.location.origin + '/ace-modes/typst.js';
  ace.config.setModuleUrl('ace/mode/typst', modePath);
  aceModeLoaded = true;
  console.log('[TypstHandler] Custom Typst Ace mode registered with Ace config');
}

function isAceModeLoaded() {
  return aceModeLoaded;
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
