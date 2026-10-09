// Types for the GoldenLayout host boundary; no upstream UI framework is required.
export interface FileViewerZoomState {
    scale: number; label: string; canZoomIn: boolean; canZoomOut: boolean;
    canReset: boolean; minScale: number; maxScale: number;
}
export interface FileViewerRenderedInstance { $el: HTMLElement; unmount(): void }
export interface FileRenderContext {
    signal?: AbortSignal;
    options?: {locale?: string; design?: Record<string, any>; onDiagnostic?: (message: unknown) => void};
    onProgressiveRender?: () => void;
    registerThumbnailAdapter?: (adapter: unknown) => void;
    registerExportAdapter?: (adapter: unknown) => void;
}
