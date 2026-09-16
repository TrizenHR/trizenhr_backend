import Organization from '../models/Organization';

export const DEFAULT_TIMEZONE = 'Asia/Kolkata';

export async function getOrganizationTimezone(organizationId: string): Promise<string> {
  const org = await Organization.findById(organizationId).select('settings.timezone').lean();
  const tz = org?.settings?.timezone?.trim();
  return tz || DEFAULT_TIMEZONE;
}

/** Calendar date yyyy-MM-dd in the given IANA timezone. */
export function getOrgCalendarDate(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

/** UTC instant for 00:00:00 on a calendar day in the given timezone. */
export function startOfOrgCalendarDay(dateInput: string | Date, timeZone: string): Date {
  const dateStr =
    typeof dateInput === 'string'
      ? dateInput.trim().slice(0, 10)
      : getOrgCalendarDate(dateInput, timeZone);

  const [year, month, day] = dateStr.split('-').map((part) => Number(part));
  if (!year || !month || !day) {
    throw new Error(`Invalid calendar date: ${dateStr}`);
  }

  let utc = Date.UTC(year, month - 1, day, 12, 0, 0, 0);
  for (let attempt = 0; attempt < 48; attempt += 1) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hour12: false,
    }).formatToParts(new Date(utc));

    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
    const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
    const second = Number(parts.find((p) => p.type === 'second')?.value ?? 0);
    const y = Number(parts.find((p) => p.type === 'year')?.value ?? year);
    const m = Number(parts.find((p) => p.type === 'month')?.value ?? month);
    const d = Number(parts.find((p) => p.type === 'day')?.value ?? day);

    if (y === year && m === month && d === day && hour === 0 && minute === 0 && second === 0) {
      return new Date(utc);
    }

    utc -= ((hour * 60 + minute) * 60 + second) * 1000;
  }

  return new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
}

/** UTC instant for a clock time on the organization calendar date. */
export function parseOrgTimeOnDate(
  dateInput: string | Date,
  time: string,
  timeZone: string
): Date {
  const dateKey = typeof dateInput === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateInput.slice(0, 10)) && dateInput.length <= 10
    ? dateInput
    : getOrgCalendarDate(new Date(dateInput), timeZone);
  const [hours, minutes] = time.split(':').map((part) => Number(part));
  const dayStart = startOfOrgCalendarDay(dateKey, timeZone);
  return new Date(dayStart.getTime() + (hours * 60 + minutes) * 60 * 1000);
}

export function endOfOrgCalendarDay(dateInput: string | Date, timeZone: string): Date {
  const start = startOfOrgCalendarDay(dateInput, timeZone);
  const nextDay = getOrgCalendarDate(new Date(start.getTime() + 36 * 60 * 60 * 1000), timeZone);
  const nextStart = startOfOrgCalendarDay(nextDay, timeZone);
  return new Date(nextStart.getTime() - 1);
}
