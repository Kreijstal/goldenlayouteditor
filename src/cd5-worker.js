const { parseCd5, decodeLayer, layerRgba } = require('./cd5');
let doc;
self.onmessage = ({data}) => {
    if (data.type === 'open') {
        doc = parseCd5(new Uint8Array(data.buffer));
        self.postMessage({id:data.id, type:'opened', version:doc.version, creator:doc.creator,
            layers:doc.layers.map(({bands, ...layer}) => ({...layer, bandCount:bands.length}))});
    } else if (data.type === 'layer') {
        if (!doc || !Number.isInteger(data.index) || !doc.layers[data.index]) throw new Error('CD5: invalid layer selection');
        const layer = doc.layers[data.index];
        if (!layer.pixelSize) throw new Error('CD5: linked layers require their native document relationships');
        const rgba = layerRgba(layer, decodeLayer(layer).pixels);
        self.postMessage({id:data.id, type:'pixels', width:layer.width, height:layer.height, rgba:rgba.buffer}, [rgba.buffer]);
    } else throw new Error('CD5: unknown worker request');
};
