export function shortcutUrl(bytes,name){
 const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);let value;
 if(/\.webloc$/i.test(name)){const doc=new DOMParser().parseFromString(text,'application/xml');if(doc.querySelector('parsererror'))throw Error('Invalid Webloc property list');const dict=doc.querySelector('plist>dict');if(!dict)throw Error('Missing Webloc dictionary');const children=[...dict.children];for(let i=0;i<children.length;i+=2)if(children[i].tagName==='key'&&children[i].textContent==='URL'&&children[i+1]?.tagName==='string'){if(value!==undefined)throw Error('Duplicate Webloc URL');value=children[i+1].textContent;}}
 else{for(const line of text.split(/\r?\n/)){const match=/^URL=(.+)$/.exec(line);if(match){if(value!==undefined)throw Error('Duplicate Internet Shortcut URL');value=match[1];}}}
 if(!value)throw Error('Shortcut has no URL');new URL(value);return new TextEncoder().encode(value);
}
