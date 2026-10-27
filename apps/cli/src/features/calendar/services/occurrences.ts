import type { DateTime } from 'effect';
import ICAL from 'ical.js';
import { instantOf, type TimeWindow } from './ical-time';

// One occurrence of an event: the event itself, or one instance of a
// recurring event, drawn from the override that changed it if there is one.
export type Occurrence = {
  readonly event: ICAL.Event;
  readonly start: ICAL.Time;
  readonly end: ICAL.Time;
  readonly startMs: number;
  readonly endMs: number;
  readonly recurrenceId?: { readonly time: ICAL.Time; readonly ms: number };
};

// Stops a rule without an end, such as FREQ=MINUTELY, from running forever.
// A series with more occurrences before the window ends can't be listed.
const maxRuleSteps = 50_000;

// ical.js 2.2.1 looks for a rule's next date in a loop inside
// RecurIterator.next() that gives up only for MONTHLY and YEARLY rules, so a
// rule that matches no date, such as FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30,
// never returns, and no timeout can stop synchronous code. The loop tests
// each candidate date with check_contracting_rules, so counting those calls
// per iterator bounds its work, including the first search that
// Event.iterator() already runs.
const maxCandidates = 200_000;
const candidatesTested = new WeakMap<ICAL.RecurIterator, number>();
const checkContractingRules =
  ICAL.RecurIterator.prototype.check_contracting_rules;
ICAL.RecurIterator.prototype.check_contracting_rules = function (
  this: ICAL.RecurIterator,
): boolean {
  const tested = (candidatesTested.get(this) ?? 0) + 1;
  if (tested > maxCandidates) {
    throw new Error(
      `its rule ${this.rule.toString()} needed more than ${maxCandidates} candidate dates, so it may match no date at all`,
    );
  }
  candidatesTested.set(this, tested);
  return checkContractingRules.call(this);
};

export const tzidOf = (
  component: ICAL.Component,
  property: string,
): string | undefined => {
  const value = component.getFirstProperty(property)?.getParameter('tzid');
  return typeof value === 'string' ? value : undefined;
};

const uidOf = (component: ICAL.Component): string =>
  String(component.getFirstPropertyValue('uid') ?? '');

// A date-only event without an end lasts one day (RFC 5545, section 3.6.1).
const endOf = (start: ICAL.Time, end: ICAL.Time): ICAL.Time => {
  if (!start.isDate || end.compare(start) > 0) {
    return end;
  }
  const nextDay = start.clone();
  nextDay.adjust(1, 0, 0, 0);
  return nextDay;
};

// Where an instance of a series sits in its rule, before any override moved
// it, and the zone of that slot.
type Slot = {
  readonly time: ICAL.Time;
  readonly tzid: string | undefined;
};

// An event, or one instance of a series, with its times as written.
type Instance = {
  readonly event: ICAL.Event;
  readonly start: ICAL.Time;
  readonly end: ICAL.Time;
  readonly slot?: Slot;
};

const occurrence = (
  { event, start, end, slot }: Instance,
  local: DateTime.TimeZone,
): Occurrence => {
  const startTzid = tzidOf(event.component, 'dtstart');
  const startMs = instantOf(start, startTzid, local);
  const fullEnd = endOf(start, end);
  return {
    event,
    start,
    end: fullEnd,
    startMs,
    endMs: Math.max(
      startMs,
      instantOf(fullEnd, tzidOf(event.component, 'dtend') ?? startTzid, local),
    ),
    ...(slot === undefined
      ? {}
      : {
          recurrenceId: {
            time: slot.time,
            ms: instantOf(slot.time, slot.tzid, local),
          },
        }),
  };
};

// An event as stored, without expanding a rule.
const asStored = (event: ICAL.Event, slot?: Slot): Instance => ({
  event,
  start: event.startDate,
  end: event.endDate,
  ...(slot === undefined ? {} : { slot }),
});

// An event without duration still counts when it starts inside the window.
export const overlaps = (
  { startMs, endMs }: Pick<Occurrence, 'startMs' | 'endMs'>,
  window: TimeWindow,
): boolean =>
  startMs < window.endMs && Math.max(endMs, startMs + 1) > window.startMs;

const inWindow = (
  instance: Instance,
  window: TimeWindow,
  local: DateTime.TimeZone,
): ReadonlyArray<Occurrence> => {
  const found = occurrence(instance, local);
  return overlaps(found, window) ? [found] : [];
};

// The rule's occurrences until the window ends, with overrides applied.
const ruleOccurrences = (
  event: ICAL.Event,
  ruleTzid: string | undefined,
  window: TimeWindow,
  local: DateTime.TimeZone,
): ReadonlyArray<Occurrence> => {
  const found: Array<Occurrence> = [];
  const iterator = event.iterator();
  for (
    let step = 0, next = iterator.next();
    next !== null &&
    next !== undefined &&
    instantOf(next, ruleTzid, local) < window.endMs;
    step += 1, next = iterator.next()
  ) {
    if (step === maxRuleSteps) {
      throw new Error(
        `it repeats more than ${maxRuleSteps} times before the end of the requested time range`,
      );
    }
    const details = event.getOccurrenceDetails(next);
    const slotTzid =
      details.item === event
        ? ruleTzid
        : (tzidOf(details.item.component, 'recurrence-id') ?? ruleTzid);
    found.push(
      ...inWindow(
        {
          event: details.item,
          start: details.startDate,
          end: details.endDate,
          slot: { time: details.recurrenceId, tzid: slotTzid },
        },
        window,
        local,
      ),
    );
  }
  return found;
};

// An override can move an occurrence from after the window into it; the
// rule stopped before reaching its original slot.
const movedIntoWindow = (
  overrides: ReadonlyArray<ICAL.Component>,
  ruleTzid: string | undefined,
  window: TimeWindow,
  local: DateTime.TimeZone,
): ReadonlyArray<Occurrence> =>
  overrides.flatMap((component) => {
    const moved = new ICAL.Event(component);
    const slot = {
      time: moved.recurrenceId,
      tzid: tzidOf(component, 'recurrence-id') ?? ruleTzid,
    };
    return instantOf(slot.time, slot.tzid, local) < window.endMs
      ? []
      : inWindow(asStored(moved, slot), window, local);
  });

const expandSeries = (
  master: ICAL.Component,
  overrides: ReadonlyArray<ICAL.Component>,
  window: TimeWindow,
  local: DateTime.TimeZone,
): ReadonlyArray<Occurrence> => {
  const event = new ICAL.Event(master, { exceptions: [...overrides] });
  if (!event.isRecurring()) {
    return inWindow(asStored(event), window, local);
  }
  const ruleTzid = tzidOf(master, 'dtstart');
  try {
    return [
      ...ruleOccurrences(event, ruleTzid, window, local),
      ...movedIntoWindow(overrides, ruleTzid, window, local),
    ];
  } catch (cause) {
    // ical.js's own errors don't say which event they are about.
    throw new Error(
      `Could not work out the occurrences of event ${event.uid}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
};

// The occurrences of every event in one calendar object that overlap the
// window. Overrides without their series, as when someone invited the user
// to a single instance, stand alone.
export const occurrencesIn = (
  vcalendar: ICAL.Component,
  window: TimeWindow,
  local: DateTime.TimeZone,
): ReadonlyArray<Occurrence> => {
  const vevents = vcalendar.getAllSubcomponents('vevent');
  const isOverride = (component: ICAL.Component) =>
    component.hasProperty('recurrence-id');
  const masters = vevents.filter((component) => !isOverride(component));
  const overrides = vevents.filter(isOverride);
  const masterUids = new Set(masters.map(uidOf));
  return [
    ...masters.flatMap((master) =>
      expandSeries(
        master,
        overrides.filter((override) => uidOf(override) === uidOf(master)),
        window,
        local,
      ),
    ),
    ...overrides
      .filter((override) => !masterUids.has(uidOf(override)))
      .flatMap((component) => {
        const lone = new ICAL.Event(component);
        const slot = {
          time: lone.recurrenceId,
          tzid: tzidOf(component, 'recurrence-id'),
        };
        return inWindow(asStored(lone, slot), window, local);
      }),
  ];
};
