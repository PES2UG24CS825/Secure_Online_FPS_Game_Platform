from collections import Counter
from collections import defaultdict


EVENT_FIELDS = {
    "kills": "enemy_killed",
    "deaths": "player_death",
    "shots_fired": "weapon_fire",
    "shots_hit": "enemy_hit",
}

SUMMARY_FIELDS = {
    "kills": ("kills",),
    "deaths": ("deaths",),
    "shots_fired": ("shots_fired", "shots"),
    "shots_hit": ("shots_hit", "hits"),
}


def group_telemetry_by_session(events):
    grouped = defaultdict(list)
    for event in events:
        if event.get("session_id"):
            grouped[event["session_id"]].append(event)
    return grouped


def resolve_match_combat_stats(summary, telemetry_events):
    event_counts = Counter(event.get("event_type") for event in telemetry_events)
    cmpl_telem = {}
    for event in telemetry_events:
        if event.get("event_type") == "game_completed" and isinstance(event.get("telemetry"), dict):
            cmpl_telem = event["telemetry"]
            break

    stats = {}
    for metric, event_type in EVENT_FIELDS.items():
        stored = next(
            (summary[key] for key in SUMMARY_FIELDS[metric] if summary.get(key) is not None),
            None,
        )
        observed = event_counts[event_type]
        cmpl_val = next(
            (cmpl_telem[key] for key in SUMMARY_FIELDS[metric] if cmpl_telem.get(key) is not None),
            None,
        )
        sources = (stored,) if summary.get("stats_source") == "multiplayer_server" else (stored, observed, cmpl_val)
        candidates = [int(v) for v in sources if v is not None]
        stats[metric] = max(candidates) if candidates else None

    kills = stats["kills"]
    deaths = stats["deaths"]
    shots = stats["shots_fired"]
    hits = stats["shots_hit"]
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

    kills = totals["kills"] or 0
    deaths = totals["deaths"] or 0
    shots = totals["shots_fired"]
    hits = totals["shots_hit"]
    totals["kdr"] = round(kills / max(deaths, 1), 2)
    totals["accuracy"] = (
        round((hits / shots) * 100, 1)
        if shots is not None and hits is not None and shots > 0
        else None
    )
    return totals, resolved
