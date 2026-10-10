import JSON5 from 'json5';
export function parsedJson5(text){const value=JSON5.parse(text);return JSON.stringify(value,(_,item)=>typeof item==='number'&&!Number.isFinite(item)?String(item):item);}
