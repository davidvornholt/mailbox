import ICAL from 'ical.js';
import { timeKey } from './ical-time';
import { occurrenceKey, sequenceOf } from './invitation';

const stampOf = (event: ICAL.Component): number | undefined => {
  const value = event.getFirstPropertyValue('dtstamp');
  return value instanceof ICAL.Time ? value.toUnixTime() : undefined;
};

// Messages about an event come in order of SEQUENCE, and of DTSTAMP within
// one SEQUENCE (RFC 5546, section 2.1.5).
export const isNewer = (
  incoming: ICAL.Component,
  stored: ICAL.Component | undefined,
): boolean => {
  if (stored === undefined) {
    return true;
  }
  const sequence = sequenceOf(incoming) - sequenceOf(stored);
  if (sequence !== 0) {
    return sequence > 0;
  }
  const incomingStamp = stampOf(incoming);
  const storedStamp = stampOf(stored);
  return (
    incomingStamp !== undefined &&
    storedStamp !== undefined &&
    incomingStamp > storedStamp
  );
};

export const eventAt = (
  vcalendar: ICAL.Component,
  key: string,
): ICAL.Component | undefined =>
  vcalendar
    .getAllSubcomponents('vevent')
    .find((event) => occurrenceKey(event) === key);

// The SEQUENCE of the cancellation an EXDATE that pim adds stands for, so
// that an older invitation to the occurrence does not bring it back.
const cancelledAt = 'x-pim-sequence';

const keysOf = (exdate: ICAL.Property): ReadonlyArray<string> =>
  exdate
    .getValues()
    .map((value) => timeKey(value, exdate.getParameter('tzid')));

const cancellationOf = (exdate: ICAL.Property): number | undefined => {
  const value = Number(exdate.getParameter(cancelledAt));
  return Number.isInteger(value) ? value : undefined;
};

// The SEQUENCE since which the series excludes the occurrence: that of the
// cancellation pim recorded, or else that of the series. None when the
// series does not exclude it.
export const excludedSince = (
  series: ICAL.Component,
  key: string,
): number | undefined => {
  const exdates = series
    .getAllProperties('exdate')
    .filter((exdate) => keysOf(exdate).includes(key));
  return exdates.length === 0
    ? undefined
    : Math.max(
        sequenceOf(series),
        ...exdates.map((exdate) => cancellationOf(exdate) ?? 0),
      );
};

export const removeExclusion = (series: ICAL.Component, key: string): void => {
  for (const exdate of series.getAllProperties('exdate')) {
    const tzid = exdate.getParameter('tzid');
    const values = exdate.getValues();
    const kept = values.filter((value) => timeKey(value, tzid) !== key);
    if (kept.length === 0) {
      series.removeProperty(exdate);
    } else if (kept.length < values.length) {
      exdate.setValues(kept);
    }
  }
};

// Excludes the occurrence a cancellation is for from the series, with the
// time and zone of its RECURRENCE-ID, and records the cancellation's
// SEQUENCE.
export const exclude = (
  series: ICAL.Component,
  cancelled: ICAL.Component,
): void => {
  removeExclusion(series, occurrenceKey(cancelled));
  const [, parameters, type, value] = structuredClone(
    cancelled.getFirstProperty('recurrence-id')?.toJSON(),
  );
  const exdate = new ICAL.Property(['exdate', parameters, type, value]);
  exdate.setParameter(cancelledAt, String(sequenceOf(cancelled)));
  series.addProperty(exdate);
};

// Gives a series that replaces another the cancellations pim recorded in
// the other that are no older than it. Both must be in the calendar, so
// that their times resolve.
export const keepCancellations = (
  before: ICAL.Component,
  series: ICAL.Component,
): void => {
  for (const exdate of before.getAllProperties('exdate')) {
    const cancellation = cancellationOf(exdate);
    if (
      cancellation !== undefined &&
      cancellation >= sequenceOf(series) &&
      keysOf(exdate).some((key) => excludedSince(series, key) === undefined)
    ) {
      series.addProperty(new ICAL.Property(structuredClone(exdate.toJSON())));
    }
  }
};
