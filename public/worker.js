// Service Worker for serving files dynamically (offline-capable)
let files = new Map(); // Store all files by filename

// Utility function to get MIME type from file extension
function getMimeType(fileName) {
    const extension = fileName.split('.').pop().toLowerCase();
    switch (extension) {
        case 'js':
            return 'application/javascript';
        case 'css':
            return 'text/css';
        case 'html':
        case 'htm':
            return 'text/html';
        case 'json':
            return 'application/json';
        case 'txt':
            return 'text/plain';
        default:
            return 'text/plain';
    }
}

// Install event
self.addEventListener('install', (event) => {
    console.log('[ServiceWorker] Installing');
    self.skipWaiting();
});

// Activate event
self.addEventListener('activate', (event) => {
    console.log('[ServiceWorker] Activated');
    event.waitUntil(self.clients.claim());
});

// Handle messages from main thread
self.addEventListener('message', (event) => {
    const { type, fileName, content } = event.data;
    
    switch (type) {
        case 'updateFile':
            files.set(fileName, content || '');
            console.log(`[ServiceWorker] File content updated for ${fileName}`);
            // Notify all clients that file has been updated
            self.clients.matchAll().then(clients => {
                clients.forEach(client => {
                    client.postMessage({
                        type: 'fileUpdated',
                        fileName: fileName
                    });
                });
            });
            break;
    }
});

// Intercept fetch requests
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    const pathname = url.pathname;
    
    // Remove leading slash and preview prefix to get the file path
    let filePath = pathname.startsWith('/preview/') ? pathname.slice(9) : pathname.slice(1);
    
    // Check if this is a request for a file we're managing
    if ((pathname.includes('/preview/') || pathname.startsWith('/')) && files.has(filePath)) {
        const fileName = filePath.split('/').pop(); // Get just the filename for MIME type
        event.respondWith(
            new Response(files.get(filePath), {
                headers: {
                    'Content-Type': getMimeType(fileName),
                    'Cache-Control': 'no-cache'
                }
            })
        );
    }
});