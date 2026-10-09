// Adapted from xushanpei/open-file-viewer, commit 6d85f230f0cf62320ffea146c2de6f15feb6cecb.
// Copyright (c) 2026 xushanpei. MIT; see public/licenses/imported-viewers/open-file-viewer-MIT.txt.
// JavaScript derived from plugins/xmind.ts; host adapter, labels and resource handling changed.
"use strict";
const JSZip = require('jszip');
const MAX_TOPIC_COUNT = 2000;
const MAX_TOPIC_DEPTH = 128;
const NODE_WIDTH = 228;
const ROOT_WIDTH = 260;
const LEVEL_GAP = 96;
const SIBLING_GAP = 20;
const CANVAS_PADDING = 40;
async function parseXMindWorkbook(buffer) {
    const zip = await JSZip.loadAsync(buffer);
    const contentJson = findZipFile(zip, "content.json");
    const contentXml = findZipFile(zip, "content.xml");
    const objectUrls = [];
    try {
        const resources = await loadImageResources(zip, objectUrls);
        if (contentJson) {
            return {
                sheets: parseXMindContentJson(await contentJson.async("text"), resources),
                objectUrls
            };
        }
        if (contentXml) {
            return {
                sheets: parseXMindContentXml(await contentXml.async("text"), resources),
                objectUrls
            };
        }
    }
    catch (error) {
        revokeObjectUrls(objectUrls);
        throw error;
    }
    revokeObjectUrls(objectUrls);
    throw new Error("Missing XMind content.json/content.xml");
}
function findZipFile(zip, fileName) {
    const expected = fileName.toLowerCase();
    return Object.values(zip.files).find((entry) => !entry.dir && entry.name.split("/").pop()?.toLowerCase() === expected);
}
async function loadImageResources(zip, objectUrls) {
    const resources = new Map();
    if (typeof URL.createObjectURL !== "function") {
        return resources;
    }
    const entries = Object.values(zip.files).filter((entry) => !entry.dir && /(^|\/)(resources|attachments)\//i.test(entry.name) && isImageFile(entry.name));
    for (const entry of entries.slice(0, 256)) {
        const blob = await entry.async("blob");
        const objectUrl = URL.createObjectURL(blob);
        objectUrls.push(objectUrl);
        registerResourceAliases(resources, entry.name, objectUrl);
    }
    return resources;
}
function registerResourceAliases(resources, path, url) {
    const normalized = normalizeResourcePath(path);
    resources.set(normalized, url);
    resources.set(`xap:${normalized}`, url);
    resources.set(normalized.replace(/^\/?(resources|attachments)\//, ""), url);
}
function isImageFile(path) {
    return /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)$/i.test(path);
}
function normalizeResourcePath(path) {
    return path.replace(/^xap:/i, "").replace(/^\/+/, "").replace(/\\/g, "/").toLowerCase();
}
function resolveResource(source, resources) {
    const value = source.trim();
    if (/^(?:data:image\/|blob:)/i.test(value)) {
        return value;
    }
    const normalized = normalizeResourcePath(value);
    return resources.get(normalized) || resources.get(normalized.replace(/^\/?(resources|attachments)\//, ""));
}
function parseXMindContentJson(source, resources) {
    const raw = JSON.parse(source);
    const candidates = readJsonSheets(raw);
    const budget = { count: 0 };
    const parsed = candidates
        .map((sheet, index) => parseXMindJsonSheet(sheet, index, resources, budget))
        .filter((sheet) => Boolean(sheet));
    if (parsed.length === 0) {
        throw new Error("No readable XMind sheets");
    }
    return parsed;
}
function readJsonSheets(raw) {
    if (Array.isArray(raw)) {
        return raw;
    }
    if (!isRecord(raw)) {
        return [];
    }
    if (Array.isArray(raw.sheets)) {
        return raw.sheets;
    }
    if (isRecord(raw.rootTopic) || isRecord(raw.root)) {
        return [raw];
    }
    if (isRecord(raw.content)) {
        return readJsonSheets(raw.content);
    }
    return [];
}
function parseXMindJsonSheet(raw, index, resources, budget) {
    if (!isRecord(raw)) {
        return undefined;
    }
    const rootTopic = isRecord(raw.rootTopic) ? raw.rootTopic : isRecord(raw.root) ? raw.root : undefined;
    if (!rootTopic) {
        return undefined;
    }
    const root = parseXMindJsonTopic(rootTopic, resources, budget, 0, "attached");
    return {
        title: readString(raw.title) || root.title || `Sheet ${index + 1}`,
        root
    };
}
function parseXMindJsonTopic(raw, resources, budget, depth, kind) {
    consumeTopicBudget(budget, depth);
    const children = [];
    const childrenContainer = raw.children;
    if (Array.isArray(childrenContainer)) {
        appendJsonChildren(children, childrenContainer, "attached", resources, budget, depth);
    }
    else if (isRecord(childrenContainer)) {
        for (const childKind of ["attached", "detached", "summary", "callout"]) {
            appendJsonChildren(children, childrenContainer[childKind], childKind, resources, budget, depth);
        }
    }
    const image = isRecord(raw.image) ? readString(raw.image.src) || readString(raw.image.href) : readString(raw.image);
    return {
        id: readString(raw.id) || `topic-${budget.count}`,
        title: readString(raw.title) || readString(raw.text) || "Untitled",
        children,
        notes: readXMindJsonNotes(raw.notes),
        labels: readStringArray(raw.labels),
        markers: readMarkerIds(raw.markers),
        hyperlink: readString(raw.href) || readString(raw.hyperlink) || undefined,
        image: image ? resolveResource(image, resources) || image : undefined,
        kind
    };
}
function appendJsonChildren(target, raw, kind, resources, budget, parentDepth) {
    if (!Array.isArray(raw)) {
        return;
    }
    for (const child of raw) {
        if (isRecord(child)) {
            target.push(parseXMindJsonTopic(child, resources, budget, parentDepth + 1, kind));
        }
    }
}
function readXMindJsonNotes(raw) {
    if (typeof raw === "string") {
        return raw.trim() ? [raw.trim()] : [];
    }
    if (!isRecord(raw)) {
        return [];
    }
    const values = ["plain", "realHTML", "html"]
        .map((key) => {
        const note = raw[key];
        return isRecord(note) ? readString(note.content) : readString(note);
    })
        .map(stripHtml)
        .filter(Boolean);
    return [...new Set(values)];
}
function readMarkerIds(raw) {
    if (!Array.isArray(raw)) {
        return [];
    }
    return raw
        .map((marker) => {
        if (typeof marker === "string") {
            return marker.trim();
        }
        return isRecord(marker) ? readString(marker.markerId) || readString(marker["marker-id"]) || readString(marker.id) : "";
    })
        .filter(Boolean);
}
function parseXMindContentXml(source, resources) {
    const doc = new DOMParser().parseFromString(source, "application/xml");
    if (doc.querySelector("parsererror")) {
        throw new Error("Invalid XMind XML");
    }
    const sheets = Array.from(doc.getElementsByTagName("*")).filter((element) => element.localName === "sheet");
    const budget = { count: 0 };
    const parsed = sheets
        .map((sheet, index) => parseXMindXmlSheet(sheet, index, resources, budget))
        .filter((sheet) => Boolean(sheet));
    if (parsed.length === 0) {
        throw new Error("No readable XMind sheets");
    }
    return parsed;
}
function parseXMindXmlSheet(sheet, index, resources, budget) {
    const rootTopic = firstDirectChild(sheet, "topic");
    if (!rootTopic) {
        return undefined;
    }
    const root = parseXMindXmlTopic(rootTopic, resources, budget, 0, "attached");
    return {
        title: directChildText(sheet, "title") || root.title || `Sheet ${index + 1}`,
        root
    };
}
function parseXMindXmlTopic(topic, resources, budget, depth, kind) {
    consumeTopicBudget(budget, depth);
    const children = directXmlChildTopics(topic).map(({ topic: child, kind: childKind }) => parseXMindXmlTopic(child, resources, budget, depth + 1, childKind));
    const notesContainer = firstDirectChild(topic, "notes");
    const labelsContainer = firstDirectChild(topic, "labels");
    const markersContainer = firstDirectChild(topic, "marker-refs");
    const imageElement = ownedXmlDescendants(topic, ["img", "image"])[0];
    const imageSource = imageElement ? readAttribute(imageElement, ["src", "href"]) : "";
    return {
        id: readAttribute(topic, ["id"]) || `topic-${budget.count}`,
        title: directChildText(topic, "title") || "Untitled",
        children,
        notes: notesContainer
            ? Array.from(notesContainer.getElementsByTagName("*"))
                .filter((element) => element.localName === "plain" || element.localName === "html")
                .map((element) => stripHtml(element.textContent || ""))
                .filter(Boolean)
            : [],
        labels: labelsContainer
            ? Array.from(labelsContainer.getElementsByTagName("*"))
                .filter((element) => element.localName === "label")
                .map((element) => (element.textContent || "").trim())
                .filter(Boolean)
            : [],
        markers: markersContainer
            ? Array.from(markersContainer.getElementsByTagName("*"))
                .filter((element) => element.localName === "marker-ref")
                .map((element) => readAttribute(element, ["marker-id", "markerId", "id"]))
                .filter(Boolean)
            : [],
        hyperlink: readAttribute(topic, ["href"]) || undefined,
        image: imageSource ? resolveResource(imageSource, resources) || imageSource : undefined,
        kind
    };
}
function directXmlChildTopics(topic) {
    const childrenElement = firstDirectChild(topic, "children");
    if (!childrenElement) {
        return [];
    }
    return Array.from(childrenElement.children)
        .filter((element) => element.localName === "topics")
        .flatMap((topics) => {
        const rawKind = readAttribute(topics, ["type"]);
        const kind = rawKind === "detached" || rawKind === "summary" || rawKind === "callout" ? rawKind : "attached";
        return Array.from(topics.children)
            .filter((child) => child.localName === "topic")
            .map((child) => ({ topic: child, kind }));
    });
}
function ownedXmlDescendants(topic, names) {
    return Array.from(topic.getElementsByTagName("*")).filter((element) => {
        if (!names.includes(element.localName)) {
            return false;
        }
        let parent = element.parentElement;
        while (parent && parent !== topic) {
            if (parent.localName === "topic") {
                return false;
            }
            parent = parent.parentElement;
        }
        return parent === topic;
    });
}
function readAttribute(element, names) {
    for (const attribute of Array.from(element.attributes)) {
        if (names.includes(attribute.localName) || names.includes(attribute.name)) {
            return attribute.value.trim();
        }
    }
    return "";
}
function consumeTopicBudget(budget, depth) {
    budget.count += 1;
    if (budget.count > MAX_TOPIC_COUNT) {
        throw new Error(`XMind topic limit exceeded (${MAX_TOPIC_COUNT})`);
    }
    if (depth > MAX_TOPIC_DEPTH) {
        throw new Error(`XMind topic depth limit exceeded (${MAX_TOPIC_DEPTH})`);
    }
}
function renderXMindWorkbook(panel, sheets, ctx) {
    const summary = document.createElement("section");
    summary.className = "ofv-section ofv-xmind-summary";
    const heading = document.createElement("h3");
    heading.textContent = "XMind";
    summary.append(heading);
    appendMeta(summary, "Sheets", sheets.length);
    appendMeta(summary, "Topics", countXMindTopics(sheets));
    panel.append(summary);
    const workbook = document.createElement("section");
    workbook.className = "ofv-xmind-workbook";
    const header = document.createElement("header");
    header.className = "ofv-xmind-header";
    const tabs = document.createElement("div");
    tabs.className = "ofv-xmind-tabs";
    tabs.setAttribute("role", "tablist");
    const fitButton = document.createElement("button");
    fitButton.type = "button";
    fitButton.className = "ofv-xmind-fit";
    fitButton.textContent = "Fit";
    header.append(tabs, fitButton);
    const stage = document.createElement("div");
    stage.className = "ofv-xmind-stage";
    stage.tabIndex = 0;
    stage.setAttribute("aria-label", "XMind mind map canvas");
    const surface = document.createElement("div");
    surface.className = "ofv-xmind-surface";
    stage.append(surface);
    workbook.append(header, stage);
    panel.append(workbook);
    const layouts = sheets.map((sheet) => layoutSheet(sheet));
    let activeSheet = 0;
    let scale = clamp(ctx.options.zoom, 0.2, 3);
    let panX = 24;
    let panY = 24;
    let dragging = false;
    let pointerId;
    let lastX = 0;
    let lastY = 0;
    let destroyed = false;
    const applyTransform = () => {
        surface.style.transform = `translate(${Math.round(panX)}px, ${Math.round(panY)}px) scale(${scale})`;
        const normalized = Math.round(scale * 100) / 100;
        ctx.toolbar?.setZoom(normalized === 1 ? undefined : normalized);
    };
    const centerAtScale = (nextScale) => {
        const layout = layouts[activeSheet];
        scale = clamp(nextScale, 0.2, 3);
        const width = stage.clientWidth;
        const height = stage.clientHeight;
        panX = width > 0 ? Math.max(20, (width - layout.width * scale) / 2) : 24;
        panY = height > 0 ? Math.max(20, (height - layout.height * scale) / 2) : 24;
        applyTransform();
    };
    const fitToView = () => {
        if (destroyed) return;
        const layout = layouts[activeSheet];
        const width = stage.clientWidth;
        const height = stage.clientHeight;
        if (width <= 0 || height <= 0) {
            centerAtScale(1);
            return;
        }
        centerAtScale(Math.min(1, (width - 40) / layout.width, (height - 40) / layout.height));
    };
    const zoomAround = (nextScale, clientX, clientY) => {
        const normalized = clamp(nextScale, 0.2, 3);
        const rect = stage.getBoundingClientRect();
        const pointX = clientX ?? rect.left + rect.width / 2;
        const pointY = clientY ?? rect.top + rect.height / 2;
        const localX = (pointX - rect.left - panX) / scale;
        const localY = (pointY - rect.top - panY) / scale;
        panX = pointX - rect.left - localX * normalized;
        panY = pointY - rect.top - localY * normalized;
        scale = normalized;
        applyTransform();
    };
    const renderSheet = (index, shouldFit) => {
        activeSheet = index;
        surface.replaceChildren(renderSheetLayout(layouts[index]));
        surface.style.width = `${layouts[index].width}px`;
        surface.style.height = `${layouts[index].height}px`;
        Array.from(tabs.children).forEach((tab, tabIndex) => {
            tab.setAttribute("aria-selected", String(tabIndex === index));
            tab.classList.toggle("is-active", tabIndex === index);
        });
        if (shouldFit) {
            requestAnimationFrame(fitToView);
        }
        else {
            applyTransform();
        }
    };
    for (const [index, sheet] of sheets.entries()) {
        const tab = document.createElement("button");
        tab.type = "button";
        tab.className = "ofv-xmind-tab";
        tab.setAttribute("role", "tab");
        tab.textContent = sheet.title;
        tab.addEventListener("click", () => renderSheet(index, true));
        tabs.append(tab);
    }
    const onPointerDown = (event) => {
        if (event.button !== 0) {
            return;
        }
        dragging = true;
        pointerId = event.pointerId;
        lastX = event.clientX;
        lastY = event.clientY;
        stage.classList.add("is-panning");
        stage.setPointerCapture?.(event.pointerId);
    };
    const onPointerMove = (event) => {
        if (!dragging || event.pointerId !== pointerId) {
            return;
        }
        panX += event.clientX - lastX;
        panY += event.clientY - lastY;
        lastX = event.clientX;
        lastY = event.clientY;
        applyTransform();
    };
    const endPointer = (event) => {
        if (event.pointerId !== pointerId) {
            return;
        }
        dragging = false;
        pointerId = undefined;
        stage.classList.remove("is-panning");
        stage.releasePointerCapture?.(event.pointerId);
    };
    const onWheel = (event) => {
        event.preventDefault();
        if (event.ctrlKey || event.metaKey) {
            zoomAround(scale * Math.exp(-event.deltaY * 0.002), event.clientX, event.clientY);
            return;
        }
        panX -= event.deltaX;
        panY -= event.deltaY;
        applyTransform();
    };
    const onKeyDown = (event) => {
        const distance = event.shiftKey ? 80 : 32;
        if (event.key === "ArrowLeft")
            panX += distance;
        else if (event.key === "ArrowRight")
            panX -= distance;
        else if (event.key === "ArrowUp")
            panY += distance;
        else if (event.key === "ArrowDown")
            panY -= distance;
        else
            return;
        event.preventDefault();
        applyTransform();
    };
    fitButton.addEventListener("click", fitToView);
    stage.addEventListener("pointerdown", onPointerDown);
    stage.addEventListener("pointermove", onPointerMove);
    stage.addEventListener("pointerup", endPointer);
    stage.addEventListener("pointercancel", endPointer);
    stage.addEventListener("wheel", onWheel, { passive: false });
    stage.addEventListener("keydown", onKeyDown);
    renderSheet(0, false);
    return {
        resize() {
            if (!destroyed) {
                requestAnimationFrame(fitToView);
            }
        },
        canCommand(command) {
            return command === "zoom-in" || command === "zoom-out" || command === "zoom-reset";
        },
        command(command) {
            if (command === "zoom-in") {
                zoomAround(scale * 1.15);
                return true;
            }
            if (command === "zoom-out") {
                zoomAround(scale / 1.15);
                return true;
            }
            if (command === "zoom-reset") {
                centerAtScale(1);
                return true;
            }
            return false;
        },
        destroy() {
            destroyed = true;
            fitButton.removeEventListener("click", fitToView);
            stage.removeEventListener("pointerdown", onPointerDown);
            stage.removeEventListener("pointermove", onPointerMove);
            stage.removeEventListener("pointerup", endPointer);
            stage.removeEventListener("pointercancel", endPointer);
            stage.removeEventListener("wheel", onWheel);
            stage.removeEventListener("keydown", onKeyDown);
        }
    };
}
function layoutSheet(sheet) {
    const nodes = [];
    const build = (topic, depth) => {
        const children = topic.children.map((child) => build(child, depth + 1));
        const width = depth === 0 ? ROOT_WIDTH : NODE_WIDTH;
        const height = estimateTopicHeight(topic, depth);
        const childrenHeight = children.reduce((total, child) => total + child.subtreeHeight, 0) +
            Math.max(0, children.length - 1) * SIBLING_GAP;
        const node = {
            topic,
            depth,
            x: CANVAS_PADDING + depth * (NODE_WIDTH + LEVEL_GAP),
            y: 0,
            width,
            height,
            subtreeHeight: Math.max(height, childrenHeight),
            children
        };
        nodes.push(node);
        return node;
    };
    const root = build(sheet.root, 0);
    const assign = (node, top) => {
        node.y = top + (node.subtreeHeight - node.height) / 2;
        let childTop = top;
        for (const child of node.children) {
            assign(child, childTop);
            childTop += child.subtreeHeight + SIBLING_GAP;
        }
    };
    assign(root, CANVAS_PADDING);
    const maxRight = Math.max(...nodes.map((node) => node.x + node.width));
    return {
        root,
        nodes,
        width: maxRight + CANVAS_PADDING,
        height: root.subtreeHeight + CANVAS_PADDING * 2
    };
}
function estimateTopicHeight(topic, depth) {
    const titleLines = Math.min(4, Math.max(1, Math.ceil(topic.title.length / (depth === 0 ? 18 : 22))));
    let height = 28 + titleLines * 20;
    if (topic.image)
        height += 104;
    if (topic.labels.length || topic.markers.length || topic.kind !== "attached")
        height += 30;
    if (topic.notes.length)
        height += 46;
    return Math.min(240, height);
}
function renderSheetLayout(layout) {
    const fragment = document.createDocumentFragment();
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("ofv-xmind-edges");
    svg.setAttribute("width", String(layout.width));
    svg.setAttribute("height", String(layout.height));
    svg.setAttribute("viewBox", `0 0 ${layout.width} ${layout.height}`);
    for (const node of layout.nodes) {
        for (const child of node.children) {
            const startX = node.x + node.width;
            const startY = node.y + node.height / 2;
            const endX = child.x;
            const endY = child.y + child.height / 2;
            const control = Math.max(32, (endX - startX) * 0.5);
            const edge = document.createElementNS("http://www.w3.org/2000/svg", "path");
            edge.setAttribute("d", `M ${startX} ${startY} C ${startX + control} ${startY}, ${endX - control} ${endY}, ${endX} ${endY}`);
            edge.classList.add(`ofv-xmind-edge-${child.topic.kind}`);
            svg.append(edge);
        }
    }
    fragment.append(svg);
    for (const node of layout.nodes) {
        fragment.append(renderXMindTopic(node));
    }
    return fragment;
}
function renderXMindTopic(node) {
    const topic = node.topic;
    const card = document.createElement("article");
    card.className = `ofv-xmind-topic ofv-xmind-topic-depth-${Math.min(node.depth, 4)} ofv-xmind-topic-${topic.kind}`;
    card.style.left = `${node.x}px`;
    card.style.top = `${node.y}px`;
    card.style.width = `${node.width}px`;
    card.style.height = `${node.height}px`;
    card.dataset.topicId = topic.id;
    const title = safeExternalLink(topic.hyperlink);
    if (title) {
        const link = document.createElement("a");
        link.className = "ofv-xmind-topic-title";
        link.textContent = topic.title;
        link.href = title;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        card.append(link);
    }
    else {
        const strong = document.createElement("strong");
        strong.className = "ofv-xmind-topic-title";
        strong.textContent = topic.title;
        card.append(strong);
    }
    if (topic.image && safeImageSource(topic.image)) {
        const image = document.createElement("img");
        image.className = "ofv-xmind-topic-image";
        image.src = topic.image;
        image.alt = topic.title;
        image.draggable = false;
        card.append(image);
    }
    const chips = [...topic.labels.map((value) => `#${value}`), ...topic.markers.map(formatMarker)];
    if (topic.kind !== "attached") {
        chips.unshift(topic.kind);
    }
    if (chips.length) {
        const meta = document.createElement("div");
        meta.className = "ofv-xmind-topic-meta";
        for (const value of chips.slice(0, 6)) {
            const chip = document.createElement("span");
            chip.textContent = value;
            meta.append(chip);
        }
        card.append(meta);
    }
    if (topic.notes.length) {
        const notes = document.createElement("p");
        notes.className = "ofv-xmind-topic-notes";
        notes.textContent = topic.notes[0];
        notes.title = topic.notes.join("\n");
        card.append(notes);
    }
    return card;
}
function formatMarker(marker) {
    const priority = /^priority-(\d+)$/i.exec(marker);
    if (priority)
        return `P${priority[1]}`;
    if (/^task-done$/i.test(marker))
        return "✓ done";
    const progress = /^task-(.+)$/i.exec(marker);
    if (progress)
        return `Progress ${progress[1]}`;
    return marker;
}
function safeExternalLink(value) {
    return value && /^(?:https?:|mailto:)/i.test(value) ? value : undefined;
}
function safeImageSource(value) {
    return /^(?:blob:|data:image\/)/i.test(value);
}
function countXMindTopics(sheets) {
    const countTopic = (topic) => 1 + topic.children.reduce((total, child) => total + countTopic(child), 0);
    return sheets.reduce((total, sheet) => total + countTopic(sheet.root), 0);
}
function firstDirectChild(element, localName) {
    return Array.from(element.children).find((child) => child.localName === localName);
}
function directChildText(element, localName) {
    return (firstDirectChild(element, localName)?.textContent || "").trim();
}
function readString(value) {
    return typeof value === "string" ? value.trim() : "";
}
function readStringArray(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    return value
        .map((item) => (typeof item === "string" ? item.trim() : isRecord(item) ? readString(item.text) || readString(item.value) : ""))
        .filter(Boolean);
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function stripHtml(value) {
    return value.replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/\s+/g, " ").trim();
}
function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}
function revokeObjectUrls(urls) {
    if (typeof URL.revokeObjectURL !== "function") {
        return;
    }
    for (const url of urls) {
        URL.revokeObjectURL(url);
    }
}
function appendMeta(parent, label, value) { const p = document.createElement('p'); p.textContent = label + ': ' + value; parent.append(p); }
module.exports = { parseXMindWorkbook, renderXMindWorkbook, revokeObjectUrls };
