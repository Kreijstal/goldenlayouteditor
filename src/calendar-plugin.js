const { registerPlugin } = require('./plugins');
const { ImportedViewerPanel, text, card, details, element } = require('./imported-viewer-panel');
const { parseICS, fmtDate, rruleText } = require('./ical-parser');
let ctx;
class CalendarPanel extends ImportedViewerPanel {
    constructor(container, state) {
        super(container, state, ctx, {
            accept: '.ics,.ical', search: 'Search events',
            parse(bytes) {
                const source = text(bytes);
                if (!/^BEGIN:VCALENDAR\s*$/im.test(source) || !/^END:VCALENDAR\s*$/im.test(source)) throw new Error('Expected an iCalendar calendar');
                const calendar = parseICS(source);
                return { ...calendar, summary: (calendar.calName ? calendar.calName + ' · ' : '') + calendar.events.length + ' events' };
            },
            render(model, host) {
                if (!model.events.length) element('p', 'This calendar has no events.', host);
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
