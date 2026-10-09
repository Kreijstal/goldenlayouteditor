const { registerPlugin } = require('./plugins');
const { ImportedViewerPanel, text, card, details } = require('./imported-viewer-panel');
const { parseVCards } = require('./vcard-parser');
let ctx;
class VcardPanel extends ImportedViewerPanel {
    constructor(container, state) {
        super(container, state, ctx, {
            accept: '.vcf,.vcard', search: 'Search contacts',
            parse(bytes) {
                const source = text(bytes);
                if (!/^BEGIN:VCARD\s*$/im.test(source) || !/^END:VCARD\s*$/im.test(source)) throw new Error('Expected a vCard contact file');
                const contacts = parseVCards(source);
                if (!contacts.length) throw new Error('No readable contacts');
                return { contacts, summary: contacts.length + ' contacts' };
            },
            render(model, host) {
                for (const contact of model.contacts) {
                    const node = card(host, contact.fn || 'Unnamed contact');
                    details(node, 'Organization', contact.org); details(node, 'Title', contact.title);
                    for (const entry of contact.emails) details(node, 'Email' + (entry.type ? ' (' + entry.type + ')' : ''), entry.value);
                    for (const entry of contact.tels) details(node, 'Phone' + (entry.type ? ' (' + entry.type + ')' : ''), entry.value);
                    for (const entry of contact.adrs) details(node, 'Address' + (entry.type ? ' (' + entry.type + ')' : ''), entry.value);
                    for (const url of contact.urls) details(node, 'Website', url);
                    details(node, 'Birthday', contact.bday); details(node, 'Notes', contact.note);
                }
            },
        });
    }
}
registerPlugin({ id: 'vcard', name: 'vCard contacts', components: { vcardViewer: VcardPanel },
    toolbarButtons: [{label:'Contacts',title:'Open vCard contacts',menuLabel:'vCard contacts (.vcf, .vcard)'}], init(context) { ctx = context; } });
