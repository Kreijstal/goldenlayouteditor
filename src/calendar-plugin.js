const { registerPlugin } = require('./plugins');
const { ImportedViewerPanel, text, card, details, element } = require('./imported-viewer-panel');
const { parseICS, fmtDate, rruleText } = require('./ical-parser');
const {parseFreeBusy}=require('./freebusy-parser');
let ctx;
class CalendarPanel extends ImportedViewerPanel {
    constructor(container, state) {
        super(container, state, ctx, {
            accept: '.ics,.ical,.icalendar,.ifb', search: 'Search events',
            parse(bytes) {
                if(bytes.length>2*1024*1024)throw Error('Calendar exceeds 2 MiB');
                const source = new TextDecoder('utf-8',{fatal:true}).decode(bytes);
                if (!/^BEGIN:VCALENDAR\s*$/im.test(source) || !/^END:VCALENDAR\s*$/im.test(source)) throw new Error('Expected an iCalendar calendar');
                const freeBusy=parseFreeBusy(source),calendar = parseICS(source);
                return { ...calendar, freeBusy, summary: (calendar.calName ? calendar.calName + ' · ' : '') + calendar.events.length + ' events · '+freeBusy.reduce((sum,item)=>sum+item.periods.length,0)+' free/busy periods' };
            },
            render(model, host) {
                if (!model.events.length&&!model.freeBusy.length) element('p', 'This calendar has no events or free/busy components.', host);
                for(const busy of model.freeBusy){const node=card(host,busy.uid||'Free/busy');details(node,'Organizer',busy.organizer);for(const period of busy.periods)details(node,period.type,period.start+' → '+period.end);}
                if(model.freeBusy.length)element('p','Native UTC availability periods; recurrence, time-zone rules and availability merging are not evaluated.',host);
                for (const event of model.events) {
                    const node = card(host, event.summary);
                    details(node, event.allDay ? 'All-day start' : 'Start', fmtDate(event.start));
                    details(node, event.allDay ? 'End (exclusive)' : 'End', fmtDate(event.end));
                    details(node, 'Location', event.location); details(node, 'Description', event.description);
                    details(node, 'Recurrence', event.rrule && rruleText(event.rrule) + ' · ' + event.rrule);
                    details(node, 'Status', event.status);
                }
            },
        });
    }
}
registerPlugin({ id:'calendar',name:'iCalendar events',components:{calendarViewer:CalendarPanel},
    toolbarButtons:[{label:'Calendar',title:'Open iCalendar events',menuLabel:'iCalendar events (.ics, .ical)'}],init(context){ctx=context;} });
