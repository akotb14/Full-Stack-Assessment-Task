const DATE_FORMATTER = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

const DATE_TIME_FORMATTER = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

export function formatDate(value: string | Date): string {
  return DATE_FORMATTER.format(new Date(value));
}

export function formatDateTime(value: string | Date): string {
  return DATE_TIME_FORMATTER.format(new Date(value));
}

const RELATIVE_TIME_FORMATTER = new Intl.RelativeTimeFormat('en-GB', { numeric: 'auto' });

/** Descending, so the first unit the gap fills is the one that gets used. */
const RELATIVE_UNITS: ReadonlyArray<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 365 * 24 * 60 * 60_000],
  ['month', 30 * 24 * 60 * 60_000],
  ['week', 7 * 24 * 60 * 60_000],
  ['day', 24 * 60 * 60_000],
  ['hour', 60 * 60_000],
  ['minute', 60_000],
];

/**
 * Renders a timestamp as "2 minutes ago" for the activity timeline.
 *
 * Anything under a minute reads as "just now" rather than "0 minutes ago", and
 * a timestamp slightly in the future — a clock skew between server and browser
 * — is clamped to the same wording instead of showing "in 3 seconds".
 */
export function formatRelativeTime(value: string | Date, now: Date = new Date()): string {
  const elapsed = now.getTime() - new Date(value).getTime();

  if (elapsed < 60_000) {
    return 'just now';
  }

  for (const [unit, milliseconds] of RELATIVE_UNITS) {
    if (elapsed >= milliseconds) {
      return RELATIVE_TIME_FORMATTER.format(-Math.floor(elapsed / milliseconds), unit);
    }
  }

  return 'just now';
}

/** Two-letter initials used by the avatar components. */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return '?';
  }
  if (parts.length === 1) {
    return parts[0]!.slice(0, 2).toUpperCase();
  }
  return `${parts[0]![0]}${parts[parts.length - 1]![0]}`.toUpperCase();
}
