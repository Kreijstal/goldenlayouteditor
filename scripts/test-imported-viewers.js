// Exercise imported parsers, their host adapters and lazy downloads in the production build.
const assert = require('node:assert/strict');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');
const { chromium } = require('playwright');
const JSZip = require('jszip');
const root = path.resolve(__dirname, '..');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=';
const vcard = `BEGIN:VCARD\nVERSION:2.1\nFN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:Jos=C3=\n=A9\nEMAIL;HOME:jose@example.com\nNOTE:First\\nSecond\nEND:VCARD\nBEGIN:VCARD\nVERSION:4.0\nFN:<img src=x onerror=alert(1)>\nTEL;TYPE=WORK:12345\nEND:VCARD`;
const calendar = `BEGIN:VCALENDAR\nX-WR-CALNAME:Team\nBEGIN:VEVENT\nDTSTART:20261009T120000Z\nBEGIN:VALARM\nSUMMARY:Alarm title\nDESCRIPTION:Alarm text\nEND:VALARM\nSUMMARY:Meeting\nDESCRIPTION:Event text\nRRULE:FREQ=WEEKLY;COUNT=3\nEND:VEVENT\nBEGIN:VEVENT\nDTSTART;VALUE=DATE:20261008\nDTEND;VALUE=DATE:20261009\nSUMMARY:Holiday\nEND:VEVENT\nBEGIN:VEVENT\nDTSTART;TZID=Europe/Amsterdam:20261010T100000\nSUMMARY:Local meeting\nEND:VEVENT\nEND:VCALENDAR`;
const fb2 = `<?xml version="1.0" encoding="UTF-16"?><FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink"><description><title-info><book-title>Café Book</book-title><author><first-name>Jane</first-name><last-name>Doe</last-name></author></title-info></description><body><section id="chapter"><title><p>Chapter One</p></title><p>Read <emphasis>this</emphasis> <a l:href="#note">note</a> <a l:href="javascript:alert(1)">unsafe</a>.</p><image l:href="#cover"/><section id="note"><p>Footnote</p></section></section></body><binary id="cover" content-type="image/png">${png}</binary></FictionBook>`;
async function zipFixture(file, content, image = true) {
    const zip = new JSZip(); zip.file(file, content);
    if (image) zip.file('resources/cover.png', Buffer.from(png, 'base64'));
    return [...await zip.generateAsync({type:'uint8array'})];
}
async function main() {
    const modern = await zipFixture('content.json', JSON.stringify([
        {title:'Plan',rootTopic:{title:'Project',image:{src:'xap:resources/cover.png'},notes:{plain:{content:'Root notes'}},children:{attached:[{title:'Task',labels:['Priority'],markers:[{markerId:'task-start'}]}]}}},
        {title:'Second',rootTopic:{title:'Other root',children:{attached:[{title:'Other task'}]}}},
    ]));
    const legacy = await zipFixture('content.xml', '<xmap-content xmlns="urn:xmind:xmap:xmlns:content:2.0"><sheet><title>Legacy</title><topic id="root"><title>Old root</title><children><topics type="attached"><topic id="child"><title>Old child</title></topic></topics></children></topic></sheet></xmap-content>', false);
    const badXmind = await zipFixture('content.json', '[]');
    const app = express(); const requests = [];
    app.use((req,res,next)=>{if(req.path.includes('viewer-chunks/')) requests.push(req.path);next();});
    app.get('/project/test',(_,res)=>res.send(`<div id="host" style="width:1000px;height:650px"></div><script>window.ace={config:{set(){},setModuleUrl(){}},require(){return {}},define(){}};const add=document.addEventListener.bind(document);document.addEventListener=(event,...args)=>{if(event!=='DOMContentLoaded')add(event,...args)};</script><script src="/project/bundle.js"></script>`));
    app.use('/project',express.static(path.join(root,'public')));
    const server = app.listen(0,'127.0.0.1'); await once(server,'listening');
    const browser = await chromium.launch({executablePath:process.env.TEST_CHROMIUM_PATH,headless:true,args:['--no-sandbox']});
    try {
        const page = await browser.newPage(); const errors = []; const external = [];
        page.on('pageerror',error=>errors.push(error.message));
        page.on('request',request=>{if(!request.url().startsWith('http://127.0.0.1:')&&!request.url().startsWith('data:')&&!request.url().startsWith('blob:')) external.push(request.url());});
        await page.goto(`http://127.0.0.1:${server.address().port}/project/test`);
        assert.equal(requests.length,0);
        await page.evaluate(()=>{
            window.plugins=window.__gleViewerRequire('shared:src/plugins.js').getPlugins();
            window.openViewer=async(id,component,bytes)=>{
                window.events={};document.getElementById('host').replaceChildren();
                const plugin=plugins.find(p=>p.id===id);
                plugin.init({projectFiles:{test:{id:'test',name:'sample',bytes:new Uint8Array(bytes)}}});
                window.panel=new plugin.components[component]({element:document.getElementById('host'),on:(name,fn)=>(events[name]||=[]).push(fn)},{fileId:'test'});
                await panel.ready;
            };
        });
        const open = async (id, component, bytes) => {
            const before=requests.length;
            await page.evaluate(({id,component,bytes})=>openViewer(id,component,bytes),{id,component,bytes});
            assert.equal(requests.length,before+1,`${id} should fetch only its own chunk`);
            assert.match(requests.at(-1),new RegExp(`/${id}-plugin\\.`));
        };
        await open('vcard','vcardViewer',[...Buffer.from(vcard)]);
        assert.equal(await page.locator('#host article').count(),2);
        assert.equal(await page.locator('#host article h2').first().innerText(),'José');
        assert.equal(await page.locator('#host img').count(),0);
        await page.getByRole('searchbox').fill('jose@example');
        assert.equal(await page.locator('#host article:visible').count(),1);
        await page.evaluate(()=>events.destroy.forEach(fn=>fn()));
        await open('calendar','calendarViewer',[...Buffer.from(calendar)]);
        const calendarText=await page.locator('#host').innerText();
        assert.match(calendarText,/End \(exclusive\)/);assert.match(calendarText,/UTC/);assert.match(calendarText,/Europe\/Amsterdam/);assert.match(calendarText,/Repeats weekly/);
        assert(!calendarText.includes('Alarm title')); assert(!calendarText.includes('Alarm text'));
        assert.equal(await page.locator('#host article h2').first().innerText(),'Holiday');
        await page.evaluate(()=>events.destroy.forEach(fn=>fn()));
        await open('fb2','fb2Viewer',[...Buffer.concat([Buffer.from([255,254]),Buffer.from(fb2,'utf16le')])]);
        const frame=page.frameLocator('#host iframe');
        await frame.getByText('Café Book',{exact:true}).waitFor();
        assert.equal(await frame.locator('em').innerText(),'this');
        assert.equal(await frame.locator('a[href="#note"]').count(),1);
        assert.equal(await frame.locator('a[href^="javascript:"]').count(),0);
        await page.waitForFunction(()=>document.querySelector('iframe').getAttribute('sandbox')==='');
        await frame.locator('img').waitFor();
        await page.getByLabel('Book text size').selectOption('28');
        await frame.getByText('Café Book',{exact:true}).waitFor();
        assert.match(await frame.locator('body').evaluate(el=>getComputedStyle(el).fontSize),/28px/);
        await page.evaluate(()=>events.destroy.forEach(fn=>fn()));
        await page.evaluate(()=>{
            window.created=[];window.revoked=[];
            const create=URL.createObjectURL.bind(URL),revoke=URL.revokeObjectURL.bind(URL);
            URL.createObjectURL=blob=>{const url=create(blob);created.push(url);return url;};
            URL.revokeObjectURL=url=>{revoked.push(url);revoke(url);};
        });
        await open('xmind','xmindViewer',modern);
        assert.equal(await page.locator('.ofv-xmind-tab').count(),2);
        assert.match(await page.locator('#host').innerText(),/Project/);
        assert.match(await page.locator('#host').innerText(),/Root notes/);
        assert(await page.locator('.ofv-xmind-surface svg path').count()>0);
        await page.getByRole('tab',{name:'Second'}).click();
        assert.match(await page.locator('#host').innerText(),/Other root/);
        await page.getByRole('button',{name:'100%',exact:true}).click();
        const transform=await page.locator('.ofv-xmind-surface').evaluate(el=>el.style.transform);
        await page.getByRole('button',{name:'+',exact:true}).click();
        assert.notEqual(await page.locator('.ofv-xmind-surface').evaluate(el=>el.style.transform),transform);
        await page.evaluate(()=>events.destroy.forEach(fn=>fn()));
        assert.deepEqual(await page.evaluate(()=>revoked),await page.evaluate(()=>created));
        const downloads=requests.length;
        await page.evaluate(bytes=>openViewer('xmind','xmindViewer',bytes),legacy);
        assert.match(await page.locator('#host').innerText(),/Old child/);
        assert.equal(requests.length,downloads,'reopen should use cached chunk');
        await page.evaluate(()=>events.destroy.forEach(fn=>fn()));
        for(const [id,component,bytes,message] of [
            ['vcard','vcardViewer',[...Buffer.from('not a contact')],/Expected a vCard/],
            ['calendar','calendarViewer',[...Buffer.from('ics image data')],/Expected an iCalendar/],
            ['fb2','fb2Viewer',[...Buffer.from('<FictionBook>')],/Invalid FictionBook/],
            ['xmind','xmindViewer',badXmind,/No readable XMind sheets/],
            ['xmind','xmindViewer',[1,2,3],/zip/i],
        ]) {
            const error=await page.evaluate(async({id,component,bytes})=>{try{await openViewer(id,component,bytes);}catch(error){return error.message;}},{id,component,bytes});
            assert.match(error,message);await page.evaluate(()=>events.destroy.forEach(fn=>fn()));
        }
        assert.deepEqual(await page.evaluate(()=>revoked),await page.evaluate(()=>created),'parse errors must revoke embedded image URLs');
        assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
        console.log('Imported viewers passed: contacts/search/QP, calendars/alarms/time labels, UTF-16 FB2/sandbox/notes, modern+legacy XMind/sheets/zoom, URL cleanup, malformed inputs, four isolated cached lazy chunks.');
    } finally { await browser.close();await new Promise(resolve=>server.close(resolve)); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
