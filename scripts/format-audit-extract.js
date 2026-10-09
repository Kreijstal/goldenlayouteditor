// Read declarative filename claims without importing browser-only viewer code.
const fs = require('node:fs');
const path = require('node:path');
const acorn = require('acorn');
const walk = require('acorn-walk');
const root = path.resolve(__dirname, '..');
const facts = [];
const diagnostics = [];
function read(file) {
    const source = fs.readFileSync(file, 'utf8');
    return {source, ast: acorn.parse(source, {ecmaVersion:'latest',sourceType:file.startsWith(root+path.sep)?'script':'module',locations:true})};
}
function key(property) { return property.key.name || property.key.value; }
function value(node) { return node?.type === 'Literal' ? node.value : undefined; }
function strings(node) {
    if (node?.type === 'NewExpression' && node.callee.name === 'Set') return strings(node.arguments[0]);
    if (node?.type === 'ArrayExpression') return node.elements.map(value).filter(v=>typeof v==='string');
    return [];
}
function add(project, owner, file, node, extensions=[], pattern, kind='viewer', filenames=[]) {
    facts.push({project,owner,kind,source:path.relative(root,file).replaceAll(path.sep,'/'),line:node.loc.start.line,
        extensions,filenames,...(pattern ? {pattern:pattern.pattern,flags:pattern.flags} : {})});
}
function declarations(ast) {
    const map = new Map(); walk.simple(ast,{VariableDeclarator(node){if(node.id.type==='Identifier')map.set(node.id.name,node.init);}}); return map;
}
function claims(project,owner,file,{detector=false,plugin=false}={}) {
    const {source,ast}=read(file); const vars=declarations(ast);
    const extensionPattern=node=>node?.regex && node.regex.pattern.includes('\\.') && node.regex.pattern.endsWith('$');
    function pattern(node,kind='viewer') { if(extensionPattern(node))add(project,owner,file,node,[],node.regex,kind); }
    if(detector) {
        walk.simple(ast,{
            CallExpression(node){
                if(node.callee.name==='hasExtension') {
                    const exts=[];
                    for(const arg of node.arguments.slice(1)) {
                        if(typeof value(arg)==='string')exts.push(value(arg));
                        else if(arg.type==='SpreadElement' && vars.has(arg.argument.name))exts.push(...strings(vars.get(arg.argument.name)));
                        else diagnostics.push({file:path.relative(root,file),line:node.loc.start.line,reason:'Dynamic hasExtension argument'});
                    }
                    add(project,owner,file,node,exts);
                }
                if(node.callee.type==='MemberExpression' && node.callee.property.name==='includes' && /^(ext|extension|fileExt)$/i.test(node.arguments[0]?.name || '')) {
                    const receiver=node.callee.object;
                    const exts=strings(receiver.type==='Identifier'?vars.get(receiver.name):receiver);
                    if(exts.length)add(project,owner,file,node,exts);
                }
                if(node.callee.type==='MemberExpression' && node.callee.property.name==='endsWith' && typeof value(node.arguments[0])==='string' && value(node.arguments[0]).startsWith('.'))add(project,owner,file,node,[value(node.arguments[0]).slice(1)]);
            },
            BinaryExpression(node){
                if(['===','=='].includes(node.operator)) {
                    const variable=node.left.type==='Identifier'?node.left.name:node.right.type==='Identifier'?node.right.name:'';
                    const literal=typeof value(node.right)==='string'?value(node.right):value(node.left);
                    if(typeof literal==='string' && /^(ext|extension|fileExt)$/i.test(variable))add(project,owner,file,node,[literal]);
                    if(typeof literal==='string' && /^(name|filename|base)$/i.test(variable))add(project,owner,file,node,[],undefined,'filename',[literal]);
                }
            },
            Literal(node){pattern(node);},
            VariableDeclarator(node){if(/ext(ension)?s?$/i.test(node.id.name || ''))add(project,owner,file,node,strings(node.init));},
        });
    }
    if(plugin) {
        walk.simple(ast,{
            Property(node){
                if(key(node)==='accept' && typeof value(node.value)==='string')add(project,owner,file,node,value(node.value).split(',').filter(v=>v.trim().startsWith('.')).map(v=>v.trim().slice(1)));
                if(key(node)==='canHandle')walk.simple(node.value,{
                    Literal(node){pattern(node);},
                    Identifier(node){if(vars.get(node.name)?.regex)pattern(vars.get(node.name));},
                });
            },
            AssignmentExpression(node){if(node.left.type==='MemberExpression' && node.left.property.name==='accept' && typeof value(node.right)==='string')add(project,owner,file,node,value(node.right).split(',').filter(v=>v.trim().startsWith('.')).map(v=>v.trim().slice(1)));},
        });
    }
    return {source,ast};
}
const mainFile=path.join(root,'src/main.js'); const {ast:main,source:mainSource}=read(mainFile);
walk.simple(main,{
    VariableDeclarator(node){
        if(node.id.name==='FILE_VIEWERS')for(const obj of node.init.elements){
            const props=Object.fromEntries(obj.properties.map(p=>[key(p),p.value]));
            if(props.re.regex.pattern==='^') { add('ours',value(props.componentType),mainFile,obj,[],undefined,'magic'); continue; }
            add('ours',value(props.componentType),mainFile,obj,[],props.re.regex);
        }
        if(['IMAGE_EXTS','AUDIO_EXTS','VIDEO_EXTS'].includes(node.id.name))add('ours',node.id.name,mainFile,node,strings(node.init));
    },
    BinaryExpression(node){
        if(node.loc.start.line>=950 && node.loc.start.line<=1250 && ['===','=='].includes(node.operator) && node.left.name==='ext' && ['pdf','ai','pic'].includes(value(node.right)))add('ours','core media/PDF rendering',mainFile,node,[value(node.right)]);
    },
    CallExpression(node){
        if(node.callee.type==='MemberExpression' && node.callee.property.name==='test' && node.callee.object.regex && node.callee.object.regex.pattern.includes('\\.') && node.callee.object.regex.pattern.includes('$')){
            const arg=sourceSlice(node.arguments[0]);
            if(/fileName|file\.name|\.name\b/.test(arg))add('ours','core filename handling',mainFile,node,[],node.callee.object.regex);
        }
    },
});
function sourceSlice(node){return node ? mainSource.slice(node.start,node.end) : '';}
for(const match of mainSource.matchAll(/require\(['"]\.\/([^'"]+(?:-plugin|terminal))['"]\)/g)) {
    const file=path.join(root,'src',match[1]+'.js');claims('ours',match[1],file,{plugin:true});
}
for(const relative of ['src/handlers/web-handler.js','src/handlers/typst-handler.js','public/zip-sw.js']) {
    const file=path.join(root,relative); const {ast}=read(file);
    walk.simple(ast,{
        VariableDeclarator(node){
            if(['ZIP_EXTENSIONS','webExtensions'].includes(node.id.name))add('ours',node.id.name,file,node,strings(node.init));
            if(['TAR_RE','SINGLE_RE','ISO_RE','DISK_RE','QCOW_RE'].includes(node.id.name))add('ours',node.id.name,file,node,[],node.init.regex,'archive');
        },
        BinaryExpression(node){if(relative.includes('typst') && node.left.name==='extension' && typeof value(node.right)==='string')add('ours','typst',file,node,[value(node.right)]);},
        Literal(node){if(relative.includes('typst') && node.regex?.pattern.includes('\\.'))add('ours','typst',file,node,[],node.regex);},
    });
}
for(const entry of fs.readdirSync(path.join(root,'src')).filter(name=>name.endsWith('.js') && !name.endsWith('-plugin.js') && name!=='main.js')) {
    const file=path.join(root,'src',entry);const {ast}=read(file);const vars=declarations(ast);
    function filenameHelper(node) {
        walk.simple(node,{
            Literal(node){if(node.regex?.pattern.includes('\\.') && node.regex.pattern.endsWith('$'))add('ours','decoder filename helper: '+entry,file,node,[],node.regex);},
            Identifier(node){const declaration=vars.get(node.name);if(declaration?.regex?.pattern.includes('\\.') && declaration.regex.pattern.endsWith('$'))add('ours','decoder filename helper: '+entry,file,declaration,[],declaration.regex);},
        });
    }
    walk.simple(ast,{
        FunctionDeclaration(node){if(/^is.*Name$/.test(node.id?.name || ''))filenameHelper(node);},
        VariableDeclarator(node){if(/^is.*Name$/.test(node.id.name || '') && ['ArrowFunctionExpression','FunctionExpression'].includes(node.init?.type))filenameHelper(node.init);},
    });
}
const upstream=process.argv[2];
if(upstream) {
    const jde=path.resolve(upstream,'jdeworks-file-viewer');
    const registry=path.join(jde,'docs/core/registry.js');const {ast}=read(registry);
    for(const node of ast.body.filter(n=>n.type==='ImportDeclaration' && n.source.value.endsWith('/index.js'))){
        const index=path.resolve(path.dirname(registry),node.source.value);const dir=path.dirname(index);const owner=path.relative(path.join(jde,'docs/types'),dir).replaceAll(path.sep,'/');
        const detect=path.join(dir,'detect.js');
        if(!fs.existsSync(detect)){diagnostics.push({file:path.relative(root,index),reason:'Registered type has no detect.js'});continue;}
        const count=facts.length;
        claims('jdeworks',owner,detect,{detector:true});
        if(facts.length===count)add('jdeworks',owner,detect,read(detect).ast.body[0],[],undefined,'content-only');
    }
    for(const [relative,names] of [['docs/types/text/code/langmap.js',['LANGS']],['docs/types/media/medialib.js',['VIDEO','AUDIO']],['docs/core/content-signature.js',[]]]) {
        const file=path.join(jde,relative); const {ast}=read(file);
        walk.simple(ast,{
            VariableDeclarator(node){if(names.includes(node.id.name) && node.init.type==='ObjectExpression')add('jdeworks',node.id.name,file,node,node.init.properties.map(key),undefined,node.id.name==='LANGS'?'generic-text':'viewer');},
            Property(node){if(relative.includes('content-signature') && key(node)==='extensions')add('jdeworks','content signature (detection only)',file,node,strings(node.value),undefined,'detection-only');},
        });
    }
    const knownRegistry=path.join(jde,'docs/known/registry.js');const {ast:known}=read(knownRegistry);
    for(const imp of known.body.filter(n=>n.type==='ImportDeclaration')){
        const file=path.resolve(path.dirname(knownRegistry),imp.source.value);const {ast}=read(file);const owner=path.basename(path.dirname(file));
        // Every registered schema/content enhancement is retained as its own feature.
        let label=owner;walk.simple(ast,{Property(node){if(key(node)==='label' && typeof value(node.value)==='string')label=value(node.value);}});
        add('jdeworks',owner,file,ast.body.find(node=>node.type==='ExportDefaultDeclaration') || ast.body[0],[],undefined,'enhancement',[label]);
    }
}
const unique=new Map();for(const fact of facts)if(fact.extensions.length || fact.pattern || fact.kind==='magic' || fact.kind==='enhancement' || fact.kind==='content-only' || fact.filenames.length)unique.set(JSON.stringify(fact),fact);
process.stdout.write(JSON.stringify({facts:[...unique.values()],diagnostics}));
