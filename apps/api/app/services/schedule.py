"""Send windows, working days and Wait-node delay math (all in the campaign's time zone)."""

from datetime import datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


def tz(name: str | None) -> ZoneInfo:
    try:
        return ZoneInfo(name or "UTC")
    except ZoneInfoNotFoundError:
        return ZoneInfo("UTC")


def _hm(value: str, default: time) -> time:
    try:
        h, m = value.split(":")
        return time(int(h), int(m))
    except (ValueError, AttributeError):
        return default


def window(schedule: dict) -> tuple[ZoneInfo, list[int], time, time]:
    days = schedule.get("days") or [0, 1, 2, 3, 4]
    return (
        tz(schedule.get("timezone")),
        [int(d) for d in days],
        _hm(schedule.get("start", "09:00"), time(9)),
        _hm(schedule.get("end", "17:00"), time(17)),
    )


def in_window(schedule: dict, now: datetime | None = None) -> bool:
    zone, days, start, end = window(schedule)
    local = (now or datetime.now(timezone.utc)).astimezone(zone)
    return local.weekday() in days and start <= local.time() < end


def next_window_start(schedule: dict, now: datetime | None = None) -> datetime:
    """Next moment (UTC) that falls inside the sending window."""
    zone, days, start, end = window(schedule)
    local = (now or datetime.now(timezone.utc)).astimezone(zone)
    if local.weekday() in days and start <= local.time() < end:
        return local.astimezone(timezone.utc)
    for i in range(0, 8):
        d = (local + timedelta(days=i)).date()
        if d.weekday() not in days:
            continue
        candidate = datetime.combine(d, start, zone)
        if candidate > local:
            return candidate.astimezone(timezone.utc)
    return (local + timedelta(days=1)).astimezone(timezone.utc)


def add_wait(base: datetime, *, days: int = 0, hours: int = 0, minutes: int = 0,
             working_days_only: bool = False, schedule: dict | None = None) -> datetime:
    """Wait-node math. With working_days_only, the day count skips non-working days and the
    result is pushed forward if it lands on one."""
    schedule = schedule or {}
    zone, work_days, *_ = window(schedule)
    local = base.astimezone(zone)
    if working_days_only and days:
        remaining = days
        while remaining > 0:
            local += timedelta(days=1)
            if local.weekday() in work_days:
                remaining -= 1
    else:
        local += timedelta(days=days)
    local += timedelta(hours=hours, minutes=minutes)
    if working_days_only:
        while local.weekday() not in work_days:
            local += timedelta(days=1)
    return local.astimezone(timezone.utc)
