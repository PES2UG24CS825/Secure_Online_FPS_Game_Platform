from collections import Counter
from collections import defaultdict


EVENT_FIELDS = {
    "kills": "enemy_killed",
    "deaths": "player_death",
    "shots_fired": "weapon_fire",
    "shots_hit": "enemy_hit",
    "headshots": "headshot",
}

SUMMARY_FIELDS = {
    "kills": ("kills",),
    "deaths": ("deaths",),
    "shots_fired": ("shots_fired", "shots"),
    "shots_hit": ("shots_hit", "hits"),
    "headshots": ("headshots",),
}


def metric_value(source, metric):
    for key in SUMMARY_FIELDS[metric]:
        value = source.get(key)
        if value is not None:
            return value if type(value) is int and value >= 0 else None
    return None


def completion_combat_stats(payload):
    counts = {}
    for metric, aliases in SUMMARY_FIELDS.items():
        values = [payload[key] for key in aliases if payload.get(key) is not None]
        if not values:
            continue
        if any(type(value) is not int or not 0 <= value <= 2**31 - 1 for value in values):
            raise ValueError(f"{metric} must be a nonnegative integer.")
        if len(set(values)) != 1:
            raise ValueError(f"Conflicting values for {metric}.")
        counts[metric] = values[0]
    for numerator, denominator in (("shots_hit", "shots_fired"), ("headshots", "shots_hit")):
        if numerator in counts and denominator in counts and counts[numerator] > counts[denominator]:
            raise ValueError(f"{numerator} cannot exceed {denominator}.")
    if "shots_hit" in counts and counts.get("shots_fired"):
        counts["accuracy"] = round(counts["shots_hit"] / counts["shots_fired"], 3)
    if "kills" in counts and "deaths" in counts:
        counts["kdr"] = round(counts["kills"] / max(counts["deaths"], 1), 2)
    return counts


def telemetry_counts(events):
    counts = Counter()
    seen = set()
    for event in events:
        kind = event.get("event_type")
        if kind not in EVENT_FIELDS.values():
            continue
        payload = event.get("telemetry") or {}
        shot = payload.get("shot_id") if isinstance(payload, dict) else None
        sequence = event.get("seq")
        if kind in {"weapon_fire", "enemy_hit"} and isinstance(shot, str) and shot:
            identity = (kind, "shot", shot)
        elif type(sequence) is int and sequence > 0:
            identity = (kind, "seq", sequence)
        else:
            identity = None
        if identity is not None:
            if identity in seen:
                continue
            seen.add(identity)
        counts[kind] += 1
    return counts


def group_telemetry_by_session(events):
    grouped = defaultdict(list)
    for event in events:
        if event.get("session_id"):
            grouped[event["session_id"]].append(event)
    return grouped


def resolve_match_combat_stats(summary, telemetry_events):
    event_counts = telemetry_counts(telemetry_events)
    cmpl_telem = {}
    for event in telemetry_events:
        if event.get("event_type") == "game_completed" and isinstance(event.get("telemetry"), dict):
            cmpl_telem = event["telemetry"]
            break

    stats = {}
    for metric, event_type in EVENT_FIELDS.items():
        if summary.get("stats_source") == "multiplayer_server" or any(
            summary.get(key) is not None for key in SUMMARY_FIELDS[metric]
        ):
            stats[metric] = metric_value(summary, metric)
        elif any(cmpl_telem.get(key) is not None for key in SUMMARY_FIELDS[metric]):
            stats[metric] = metric_value(cmpl_telem, metric)
        else:
            stats[metric] = event_counts.get(event_type)

    kills = stats["kills"]
    deaths = stats["deaths"]
    shots = stats["shots_fired"]
    hits = stats["shots_hit"]
    if shots is not None and hits is not None and hits > shots:
        hits = stats["shots_hit"] = None
    if hits is not None and stats["headshots"] is not None and stats["headshots"] > hits:
        stats["headshots"] = None
    stats["kdr"] = (
        round(kills / max(deaths, 1), 2)
        if kills is not None and deaths is not None
        else None
    )
    stats["accuracy"] = (
        round((hits / shots) * 100, 1)
        if shots is not None and hits is not None and shots > 0
        else None
    )
    stats["headshot_percentage"] = (
        round((stats["headshots"] / hits) * 100, 1)
        if stats["headshots"] is not None and hits is not None and hits > 0
        else None
    )
    stats["headshot_ratio"] = (
        round(stats["headshots"] / hits, 4)
        if stats["headshots"] is not None and hits is not None and hits > 0
        else None
    )
    stats["missed_shots"] = (
        max(0, shots - hits)
        if shots is not None and hits is not None
        else None
    )
    stats["non_headshot_hits"] = (
        max(0, hits - stats["headshots"])
        if hits is not None and stats["headshots"] is not None
        else None
    )
    return stats


def summarize_combat_stats(matches, telemetry_by_session):
    resolved = [
        resolve_match_combat_stats(
            match,
            telemetry_by_session.get(match.get("session_id"), ()),
        )
        for match in matches
    ]
    totals = {}
    for metric in EVENT_FIELDS:
        values = [row[metric] for row in resolved if row[metric] is not None]
        totals[metric] = sum(values) if values else None
        totals[f"{metric}_coverage"] = (
            "unavailable" if not values
            else "complete" if len(values) == len(resolved)
            else "partial"
        )

    def paired_totals(first, second):
        pairs = [(row[first], row[second]) for row in resolved
                 if row[first] is not None and row[second] is not None]
        return (sum(a for a, _ in pairs), sum(b for _, b in pairs)) if pairs else (None, None)

    kills, deaths = paired_totals("kills", "deaths")
    hits, shots = paired_totals("shots_hit", "shots_fired")
    totals["kdr"] = (
        round(kills / max(deaths, 1), 2)
        if kills is not None and deaths is not None
        else None
    )
    totals["accuracy"] = (
        round((hits / shots) * 100, 1)
        if shots is not None and hits is not None and shots > 0
        else None
    )
    sample_headshots, sample_hits = paired_totals("headshots", "shots_hit")
    totals["headshot_percentage"] = (
        round(sample_headshots / sample_hits * 100, 1)
        if sample_hits else None
    )
    return totals, resolved
